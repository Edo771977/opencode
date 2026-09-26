export * as SessionBudget from "./budget"

import type { SessionV1 } from "@opencode-ai/core/v1/session"

export type Decision = {
  /** Dollars this agent has spent in this session so far. */
  readonly spent: number
  /** Dollars this agent has spent answering the request it is answering now. */
  readonly spentOnRequest: number
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
 * ceiling asks what one request was allowed to cost and counts only the turns answering the user
 * message in hand: it is there to end a run that will not end on its own, and a run is what one
 * request sets off. Counted over the session it would end the session instead — spend never goes
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
  /** The user message being answered: the turns answering it carry its id as their `parentID`. */
  readonly request: string
  readonly budget: number | undefined
  readonly stop: number | undefined
}): Decision {
  const turns = input.messages.flatMap((message) =>
    message.info.role === "assistant" && message.info.agent === input.agent ? [message.info] : [],
  )
  const spent = turns.reduce((total, turn) => total + turn.cost, 0)
  const spentOnRequest = turns
    .filter((turn) => turn.parentID === input.request)
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
    degrade: budget !== undefined && spent >= budget,
    crossed: budget !== undefined && spent >= budget && before < budget,
    stop: input.stop !== undefined && spentOnRequest >= input.stop,
  }
}
