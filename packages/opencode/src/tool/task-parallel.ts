import * as Tool from "./tool"
import DESCRIPTION from "./task-parallel.txt"
import { ToolJsonSchema } from "./json-schema"
import { Session } from "@/session/session"
import { MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { BackgroundJob } from "@/background/job"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { TaskOutput } from "./task-output"
import type { TaskPromptOps } from "./task"
import { Config } from "@/config/config"
import { Effect, Exit, Schema } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Database } from "@opencode-ai/core/database/database"

const id = "task-parallel"

const Subtask = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the subtask" }),
  prompt: Schema.String.annotate({ description: "The subtask for the agent to perform autonomously" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this subtask" }),
  output: Schema.optional(Schema.Array(TaskOutput.Field)).annotate({
    description:
      "Fields you need back from this subtask. Set this when you will act on the answers rather than read them: the subagent is told to end with a JSON object carrying exactly these fields, and the subtask is reported as an error if it does not",
  }),
})

export const Parameters = Schema.Struct({
  tasks: Schema.Array(Subtask).annotate({
    description: "2-5 independent subtasks to run in parallel",
  }),
})

export type Outcome = { description: string; state: "completed" | "error" | "cancelled"; text: string }

export function renderSummary(results: Outcome[]) {
  const lines = results.map((r) => {
    return `- ${r.description}: ${r.state.toUpperCase()}\n${r.text
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n")}`
  })
  return ["<parallel-tasks>", ...lines, "</parallel-tasks>"].join("\n")
}

export const TaskParallelTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const database = yield* Database.Service

    const run = Effect.fn("TaskParallelTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (params.tasks.length === 0) {
        return yield* Effect.fail(new Error("tasks must contain at least one subtask"))
      }
      if (params.tasks.length > 5) {
        return yield* Effect.fail(new Error("tasks cannot contain more than 5 subtasks"))
      }

      const cfg = yield* config.get()
      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      // Gate on the `task` permission, not this tool's own id, so existing rules that restrict which
      // subagents may be spawned govern both spawn paths. Asked sequentially so the user sees one
      // prompt at a time instead of a burst.
      yield* Effect.forEach(params.tasks, (task) =>
        ctx.ask({
          permission: "task",
          patterns: [task.subagent_type],
          always: ["*"],
          metadata: {
            description: task.description,
            subagent_type: task.subagent_type,
          },
        }),
      )

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskParallelTool requires promptOps in ctx.extra"))

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant
      // Extract the parent message model here so the closures below see narrowed values.
      const parentModelID = msg.info.modelID
      const parentProviderID = msg.info.providerID

      // Resolve every agent before creating anything: a bad agent type in the middle of the list
      // would otherwise leave the sessions created for its siblings behind with no prompt and no owner.
      const resolved = yield* Effect.forEach(params.tasks, (task) =>
        Effect.gen(function* () {
          const next = yield* agent.get(task.subagent_type)
          if (!next) {
            return yield* Effect.fail(new Error(`Unknown agent type: ${task.subagent_type} is not a valid agent type`))
          }
          return { task, next }
        }),
      )

      // Create each subtask's session up front, then run them in parallel.
      const prepared = yield* Effect.forEach(
        resolved,
        ({ task, next }, index) =>
          Effect.gen(function* () {
            const childPermission = deriveSubagentSessionPermission({
              parentSessionPermission: parent.permission ?? [],
              subagent: next,
            })
            const childToolDenies = [
              ...(next.permission.some((rule) => rule.permission === "todowrite")
                ? []
                : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
              ...(next.permission.some((rule) => rule.permission === "task")
                ? []
                : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
              ...(next.permission.some((rule) => rule.permission === id)
                ? []
                : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
              // Tools an operator reserved for primary agents stay out of reach of a fan-out child,
              // exactly as they do for a child spawned through the task tool.
              ...(cfg.experimental?.primary_tools?.map((permission) => ({
                permission,
                pattern: "*" as const,
                action: "deny" as const,
              })) ?? []),
            ]
            const session = yield* sessions.create({
              parentID: ctx.sessionID,
              title: task.description + ` (@${next.name} subagent)`,
              agent: next.name,
              permission: [
                ...childPermission,
                ...childToolDenies.filter(
                  (deny) =>
                    !childPermission.some(
                      (rule) =>
                        rule.permission === deny.permission &&
                        rule.pattern === deny.pattern &&
                        rule.action === deny.action,
                    ),
                ),
              ],
            })
            const model = next.model ?? {
              modelID: parentModelID,
              providerID: parentProviderID,
            }
            return { index, task, next, session, model }
          }),
        { concurrency: "unbounded" },
      )

      // Surface the children before they finish: the UI, the children endpoint and recursive
      // cancellation all read this, and an interrupted call would otherwise never report them.
      yield* ctx.metadata({
        title: `Ran ${params.tasks.length} subtasks in parallel`,
        metadata: {
          parentSessionId: ctx.sessionID,
          subtaskSessions: prepared.map((p) => p.session.id),
        },
      })

      // A fan-out that cannot be stopped would leave every child session running after the user
      // interrupts, so mirror the task tool: cancel all children on abort and on interruption.
      const runCancel = yield* EffectBridge.make()
      const cancelAll = Effect.forEach(
        prepared,
        (p) => Effect.all([ops.cancel(p.session.id), background.cancel(p.session.id)], { discard: true }),
        { discard: true },
      )

      function onAbort() {
        runCancel.fork(cancelAll)
      }

      const runSubtask = Effect.fn("TaskParallelTool.runSubtask")(function* (p: (typeof prepared)[number]) {
        const parts = yield* ops.resolvePromptParts(p.task.prompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: p.session.id,
          model: {
            modelID: p.model.modelID,
            providerID: p.model.providerID,
          },
          variant: p.next.model ? undefined : variant,
          agent: p.next.name,
          parts: p.task.output?.length
            ? [...parts, { type: "text" as const, synthetic: true, text: TaskOutput.instruction(p.task.output) }]
            : parts,
        })
        const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
        const err =
          result.info.role === "assistant" && result.info.error
            ? ("message" in result.info.error.data &&
                typeof result.info.error.data.message === "string" &&
                result.info.error.data.message) ||
              result.info.error.name
            : undefined
        if (err) return yield* Effect.fail(new Error(String(err)))
        if (failed?.type === "tool" && failed.state.status === "error")
          return yield* Effect.fail(new Error(failed.state.error))
        const text = result.parts.findLast((item) => item.type === "text")?.text ?? ""
        if (!p.task.output?.length) return text
        const parsed = TaskOutput.parse(text, p.task.output)
        if (!parsed.ok)
          // Name the session: a fan-out subtask has no resume parameter, so its id is all the caller
          // has to look at what the work produced before deciding whether to run it again.
          return yield* Effect.fail(
            new Error(
              `Subtask did not return the requested fields (task_id: ${p.session.id}): ${parsed.error}. It answered: ${TaskOutput.excerpt(text)}`,
            ),
          )
        return JSON.stringify(parsed.value, null, 2)
      })

      // Run all subtasks in parallel, each as a background job keyed by its session id. Registering
      // them is what lets everything outside this tool call reach a running child, and it keeps one
      // failing subtask from tearing down its siblings: the failure settles that job alone.
      const fanOut = Effect.forEach(
        prepared,
        (p) =>
          Effect.gen(function* () {
            yield* background.start({
              id: p.session.id,
              type: id,
              title: p.task.description,
              metadata: {
                parentSessionId: ctx.sessionID,
                sessionId: p.session.id,
                model: p.model,
              },
              run: runSubtask(p).pipe(Effect.onInterrupt(() => ops.cancel(p.session.id))),
            })
            const info = (yield* background.wait({ id: p.session.id })).info
            if (info?.status === "completed")
              return { description: p.task.description, state: "completed" as const, text: info.output ?? "" }
            if (info?.status === "cancelled")
              return { description: p.task.description, state: "cancelled" as const, text: "Subtask cancelled" }
            // Anything else is a subtask whose result we do not have: an error, a job that is somehow
            // still running, or one missing from the registry. Reporting those as completed would tell
            // the model the work is done and hand it an empty body to reason from.
            return {
              description: p.task.description,
              state: "error" as const,
              text: info?.error ?? `Subtask did not report a result (${info?.status ?? "no job"})`,
            }
          }).pipe(Effect.onInterrupt(() => ops.cancel(p.session.id))),
        { concurrency: "unbounded" },
      )

      const outcomes = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () => fanOut,
        (_, exit) =>
          Effect.gen(function* () {
            // Not just interrupts: a prompt-layer error arrives as a defect, which interrupts the
            // sibling fibers without marking the outer exit interrupted. Any non-success exit means
            // no one is consuming these children any more, so stop them.
            if (!Exit.isSuccess(exit)) yield* cancelAll
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )

      return {
        title: `Ran ${params.tasks.length} subtasks in parallel`,
        metadata: {
          parentSessionId: ctx.sessionID,
          subtaskSessions: prepared.map((p) => p.session.id),
        },
        output: renderSummary(outcomes),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
