export * as SubagentCompletion from "./subagent-completion.js"

import { Effect } from "effect"
import type { Job } from "../job.js"
import type { Session } from "../session.js"
import type { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"
import { SubagentOutput } from "./subagent-output.js"

export const NO_TEXT = "Subagent completed without a text response."

export function text(message: SessionMessage.Info | undefined) {
  if (message?.type !== "assistant") return NO_TEXT
  return (
    message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .filter((text) => text.length > 0)
      .join("\n\n") || NO_TEXT
  )
}

/**
 * Background work a Session started and has not finished: its own background shells, and the
 * subagents it launched in the background. Each record names the Session that owns it.
 */
export const leftRunning = (jobs: Pick<Job.Interface, "pendingBackground">, sessionID: SessionSchema.ID) =>
  jobs.pendingBackground.pipe(
    Effect.map((pending) =>
      pending.filter(
        (job) =>
          job.status === "running" &&
          (job.recovery.kind === "shell"
            ? job.recovery.sessionID === sessionID
            : job.recovery.parentSessionID === sessionID),
      ),
    ),
  )

/**
 * A subagent reported as done must say what it left running. Detached work answers to the
 * subagent's own Session, so a caller told only "completed" would act on a result missing a piece.
 */
export function withLeftRunning(text: string, sessionID: SessionSchema.ID, running: readonly Job.Background[]) {
  if (running.length === 0) return text
  return [
    text,
    "",
    `${LEFT_RUNNING} (sessionID: ${sessionID}):`,
    ...running.map((job) =>
      job.recovery.kind === "shell"
        ? `- shell: ${job.recovery.command}`
        : `- subagent: ${job.recovery.description} (sessionID: ${job.recovery.childSessionID})`,
    ),
    "That work reports to the subagent's session, not to you. Do not treat the answer above as the whole result: continue the subagent with its sessionID to collect what is still running, or account for it in what you do next.",
  ].join("\n")
}

const LEFT_RUNNING = "This subagent finished its answer but left work running in its own session"

/**
 * Checks an answer against the fields its caller declared. Only the subagent's own answer is parsed;
 * what it left running is reported after the fields, never mistaken for them.
 */
export function declared(
  output: string,
  fields: readonly SubagentOutput.Field[] | undefined,
  sessionID: SessionSchema.ID,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string } {
  if (!fields?.length) return { ok: true, text: output }
  const split = output.lastIndexOf(`\n\n${LEFT_RUNNING}`)
  const answer = split < 0 ? output : output.slice(0, split)
  const note = split < 0 ? undefined : output.slice(split + 2)
  const parsed = SubagentOutput.parse(answer, fields)
  if (!parsed.ok) return { ok: false, message: SubagentOutput.failure(sessionID, parsed.error, answer) }
  return { ok: true, text: [JSON.stringify(parsed.value, null, 2), ...(note ? [note] : [])].join("\n\n") }
}

export const deliver = Effect.fnUntraced(function* (
  sessions: Pick<Session.Interface, "synthetic">,
  jobs: Pick<Job.Interface, "completeBackground">,
  input: Pick<Job.Info, "status" | "output" | "error" | "notificationID"> & {
    recovery: Extract<Job.Recovery, { kind: "subagent" }>
    resume?: boolean
  },
) {
  if (input.status === "running") return
  const recovery = input.recovery
  const checked =
    input.status === "completed"
      ? declared(input.output ?? NO_TEXT, recovery.output, recovery.childSessionID)
      : undefined
  const state = checked?.ok === false ? "error" : input.status
  const text = checked
    ? checked.ok
      ? checked.text
      : checked.message
    : input.status === "error"
      ? (input.error ?? "Subagent failed")
      : "Subagent cancelled"
  yield* sessions.synthetic({
    ...(input.notificationID ? { id: input.notificationID } : {}),
    sessionID: recovery.parentSessionID,
    ...(input.resume === false ? { resume: false } : {}),
    description: recovery.description,
    text: `<subagent sessionID="${recovery.childSessionID}" state="${state}" description="${recovery.description}">\n${text}\n</subagent>`,
    metadata: { source: "subagent", childID: recovery.childSessionID, agent: recovery.agent, state },
  })
  if (input.notificationID) yield* jobs.completeBackground(input.notificationID)
})
