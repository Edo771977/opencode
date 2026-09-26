export * as SessionBudget from "./budget"

import type { SessionV1 } from "@opencode-ai/core/v1/session"

export type Decision = {
  /** Dollars this agent has spent in this session so far. */
  readonly spent: number
  /** Dollars this agent has spent answering the request it is answering now. */
  readonly spentOnRequest: number
  /**
   * The user message this request begins at, which is not the newest one: the loop writes user
   * messages of its own while a request runs, so anything that has to mean "this request" and outlive
   * a compaction has to be keyed on this. See `requestChain`.
   */
  readonly requestOrigin: string
  /** The soft threshold was reached: run the rest of the session on the cheap model. */
  readonly degrade: boolean
  /** This is the step that reached it, so the agent is told once rather than every turn. */
  readonly crossed: boolean
  /** The ceiling was reached: stop after a final text-only turn. */
  readonly stop: boolean
}

/**
 * A budget says "work cheaply from here", not "stop". A run that has to carry a project to the end
 * cannot depend on someone noticing that it halted, so the soft threshold degrades the model and
 * the ceiling — which does halt — stays off unless an operator asks for it.
 *
 * The two thresholds count different things, because they answer different questions. The soft
 * threshold asks what this agent has cost in this session and counts every turn it has taken. The
 * ceiling asks what one request was allowed to cost and counts only the turns answering it: it is
 * there to end a run that will not end on its own, and a run is what one request sets off. Which
 * user messages make up one request is `requestChain`'s job, and not the obvious answer. Counted over the session it would end the session instead — spend never goes
 * down, so the ceiling stays reached, every later request is answered by a summary that costs more
 * than the last, and no work can ever be done again. The prompt an agent is shown at the ceiling
 * already tells it that tools come back with the next user input; this is what makes that true.
 *
 * Both are counted per agent and never across sessions: switching agents mid-session gives each its
 * own, and a subagent's session carries only its own work.
 */
export function evaluate(input: {
  readonly messages: readonly SessionV1.WithParts[]
  readonly agent: string
  /** The newest user message. The turns answering a message carry its id as their `parentID`. */
  readonly request: string
  readonly budget: number | undefined
  readonly stop: number | undefined
}): Decision {
  const turns = input.messages.flatMap((message) =>
    message.info.role === "assistant" && message.info.agent === input.agent ? [message.info] : [],
  )
  const spent = turns.reduce((total, turn) => total + turn.cost, 0)
  const chain = requestChain(input.messages, input.request)
  const answering = new Set(chain)
  const spentOnRequest = turns
    .filter((turn) => answering.has(turn.parentID))
    .reduce((total, turn) => total + turn.cost, 0)
  // What was spent before the most recent turn, which is how a threshold reached now is told apart
  // from one reached several turns ago. The most recent turn is searched for rather than taken from
  // the end of the list: history reaches here in whichever order the caller had it, and reading the
  // wrong turn tells an agent about its budget over and over, or never. Ordered the way the message
  // store itself orders, by creation time and then by id.
  const latest = turns.reduce<(typeof turns)[number] | undefined>(
    (found, turn) =>
      found === undefined ||
      turn.time.created > found.time.created ||
      (turn.time.created === found.time.created && turn.id > found.id)
        ? turn
        : found,
    undefined,
  )
  const before = spent - (latest?.cost ?? 0)
  const budget = input.budget
  return {
    spent,
    spentOnRequest,
    requestOrigin: chain[0] ?? input.request,
    degrade: budget !== undefined && spent >= budget,
    crossed: budget !== undefined && spent >= budget && before < budget,
    stop: input.stop !== undefined && spentOnRequest >= input.stop,
  }
}

/** Oldest first, the way the message store itself orders: by creation time and then by id. */
const oldestFirst = (a: SessionV1.WithParts, b: SessionV1.WithParts) =>
  a.info.time.created - b.info.time.created || (a.info.id < b.info.id ? -1 : 1)

const compactionPart = (message: SessionV1.WithParts) =>
  message.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

/** Nothing in it came from the person: every part is one the runtime wrote for the agent to read. */
const runtimeWritten = (message: SessionV1.WithParts) =>
  message.parts.length > 0 && message.parts.every((part) => part.type === "text" && part.synthetic === true)

/**
 * The user messages the ceiling counts as one request. Usually that is the single message a person
 * sent, but the loop writes user messages of its own to keep one request going: `SessionCompaction`
 * queues a compaction as a user message carrying a `compaction` part, and an automatic compaction
 * then writes the message telling the agent to continue — or replays the original request when media
 * had to be stripped out of it. Those are the runtime talking to itself. Counted as requests of
 * their own they hand the run a fresh allowance every time it compacts, which is every time it needs
 * to keep going, so a long run — the one thing a ceiling exists for — never reaches it at all.
 *
 * The compaction is not the only thing that writes one. A background subagent's result is delivered
 * as a user message in the caller's session, and a command run as a subtask writes one telling the
 * agent to summarize and carry on. Neither is a person: counted as requests of their own, an agent
 * that has delegated gets a fresh ceiling allowance and its tools back every time something it
 * started comes back, which is a way to outspend a ceiling without limit and with nobody present —
 * the one thing it exists to prevent. So a message with nothing the person wrote in it continues the
 * request instead of starting one, whoever wrote it. The person approving a plan and the record of a
 * shell command they ran are written that way too, and read correctly under the same rule: an
 * approval is a yes to the request already running, not a new one, and a shell record is charged
 * nothing. A message with no parts at all is left alone: parts are written after the message, and a
 * person's request read in that window is still theirs. One reading is arguable rather than plainly
 * right: an ACP client marks content addressed only to the assistant synthetic, so a prompt made
 * entirely of that — an editor's own context, with nothing the person typed — is counted here as a
 * continuation of what came before.
 *
 * A manual compaction ends the chain. It queues its own message but writes no continuation, so the
 * message after it is the person's and starts a request of its own. The one case this reads wrongly
 * is an automatic compaction whose continuation a plugin suppressed through
 * `experimental.compaction.autocontinue`: the person's next message then sits where the continuation
 * would have and is counted with what came before. That costs it its own ceiling allowance, and —
 * since the head of this chain is also what decides whether a budget checkpoint has been answered —
 * its own question. Telling those two apart needs a marker the runtime does not write: the
 * continuation carries only synthetic parts, but the replay an overflow writes copies the person's
 * own, so it is the person's message by this rule and has to stay in the chain either way.
 */
function requestChain(messages: readonly SessionV1.WithParts[], request: string) {
  const users = messages.filter((message) => message.info.role === "user").sort(oldestFirst)
  const upto = users.slice(0, users.findIndex((message) => message.info.id === request) + 1)
  if (upto.length === 0) return [request]
  // Oldest first, so the head of what comes back is the message the request began at.
  return upto.reduce<string[]>((chain, message, index) => {
    const previous = upto[index - 1]
    // A compaction's own message belongs to the request it was queued for, the message after an
    // automatic compaction is the continuation that compaction wrote for that same request, and a
    // message with nothing the person wrote in it was written to carry the request on as well.
    return previous !== undefined &&
      (compactionPart(message) !== undefined || compactionPart(previous)?.auto === true || runtimeWritten(message))
      ? [...chain, message.info.id]
      : [message.info.id]
  }, [])
}
