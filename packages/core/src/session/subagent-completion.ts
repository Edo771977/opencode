export * as SubagentCompletion from "./subagent-completion.js"

import { Effect } from "effect"
import type { Job } from "../job.js"
import type { SessionBackground } from "./background.js"
import type { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"
import { SubagentOutput } from "./subagent-output.js"

export const NO_TEXT = "Subagent completed without a text response."

export type RunningBackgroundItem = SessionBackground.OutstandingItem

/** A Session handle narrow enough for both Session.Service and SessionExecution to deliver a report. */
export interface SyntheticSession<E = never> {
  readonly synthetic: (input: {
    readonly id?: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly text: string
    readonly description?: string
    readonly metadata?: SessionSchema.Metadata
    readonly resume?: boolean
  }) => Effect.Effect<unknown, E>
}

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

const clean = (value: string) => value.replace(/\s+/g, " ").trim()

const BACKGROUND = "Background work still running:"

export function formatBody(
  body: string,
  childSessionID: SessionSchema.ID,
  background?: ReadonlyArray<RunningBackgroundItem>,
): string {
  if (!background || background.length === 0) return body
  const lines = background.map((item) => {
    if (item.kind === "shell")
      return `- shell (${item.shellID}${item.sessionID !== childSessionID ? `, in ${item.sessionID}` : ""}): ${clean(item.command)}`
    if (item.kind === "image")
      return `- image (${item.model}${item.sessionID !== childSessionID ? `, in ${item.sessionID}` : ""}): ${item.path}`
    return `- subagent (${item.agent}, sessionID: ${item.childSessionID}): ${clean(item.description)}`
  })
  return `${body}\n\n${BACKGROUND}\n${lines.join("\n")}`
}

/**
 * Checks an answer against the fields its caller declared. Only the subagent's own answer is parsed;
 * the background work listed after it is reported after the fields, never mistaken for them.
 */
export function declared(
  output: string,
  fields: readonly SubagentOutput.Field[] | undefined,
  sessionID: SessionSchema.ID,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string } {
  if (!fields?.length) return { ok: true, text: output }
  const split = output.lastIndexOf(`\n\n${BACKGROUND}`)
  const answer = split < 0 ? output : output.slice(0, split)
  const note = split < 0 ? undefined : output.slice(split + 2)
  const parsed = SubagentOutput.parse(answer, fields)
  if (!parsed.ok) return { ok: false, message: SubagentOutput.failure(sessionID, parsed.error, answer) }
  return { ok: true, text: [JSON.stringify(parsed.value, null, 2), ...(note ? [note] : [])].join("\n\n") }
}

export const deliver = Effect.fnUntraced(function* <E>(
  sessions: SyntheticSession<E>,
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
  const body = checked
    ? checked.ok
      ? checked.text
      : checked.message
    : input.status === "error"
      ? (input.error ?? "Subagent failed")
      : (input.output ?? input.error ?? "Subagent cancelled")
  yield* sessions.synthetic({
    ...(input.notificationID ? { id: input.notificationID } : {}),
    sessionID: recovery.parentSessionID,
    ...(input.resume === false ? { resume: false } : {}),
    description: recovery.description,
    text: `<subagent sessionID="${recovery.childSessionID}" state="${state}" description="${recovery.description}">\n${body}\n</subagent>`,
    metadata: { source: "subagent", childID: recovery.childSessionID, agent: recovery.agent, state },
  })
  if (input.notificationID) yield* jobs.completeBackground(input.notificationID)
})
