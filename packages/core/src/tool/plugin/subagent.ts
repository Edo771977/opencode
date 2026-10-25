export * as SubagentTool from "./subagent.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Predicate, Schema } from "effect"
import type { Tool } from "@opencode/schema/tool"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { Job } from "../../job.js"
import { Model } from "../../model.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentCompletion } from "../../session/subagent-completion.js"
import { SubagentJob } from "../../session/subagent-job.js"
import { SubagentOutput } from "../../session/subagent-output.js"

export const name = "subagent"

const backgroundResult = (sessionID: SessionSchema.ID) => ({
  sessionID,
  status: "running" as const,
  output: [
    `The subagent is working in the background (sessionID: ${sessionID}). You will be notified automatically when it finishes.`,
    "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.",
    "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
  ].join("\n"),
})

export const Input = Schema.Struct({
  agent: Schema.String.annotate({
    description:
      "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.",
  }),
  description: Schema.String.annotate({ description: "A short 3-5 word label for the task, displayed to the user" }),
  prompt: Schema.String.annotate({ description: "The task for the subagent to perform" }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      'NEVER set this unless the user explicitly asks for a particular model or variant. The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first.',
  }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description:
      "Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation.",
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress.",
  }),
  output: Schema.optionalKey(Schema.Array(SubagentOutput.Field)).annotate({
    description:
      "Fields you need back from the subagent. Set this when you will act on the answer rather than read it: the subagent is told to end with a JSON object carrying exactly these fields, and the call fails if it does not, instead of handing you prose to guess at.",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
})
export const description = [
  "Spawns an agent in a child session to work on the specified task.",
  "The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.",
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  "Foreground (default) runs the subagent to completion and returns its final response.",
  "Background mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.",
  "Use background only for independent work that can run while you continue elsewhere.",
].join("\n")

export const parallelName = "subagent_parallel"
const PARALLEL_LIMIT = 5

export const ParallelInput = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      agent: Input.fields.agent,
      description: Input.fields.description,
      prompt: Input.fields.prompt,
      model: Input.fields.model,
      output: Input.fields.output,
    }),
  ).annotate({ description: `2-${PARALLEL_LIMIT} independent subtasks to run at the same time` }),
})

export const ParallelOutput = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      description: Schema.String,
      sessionID: Schema.optionalKey(SessionSchema.ID),
      state: Schema.Literals(["completed", "running", "error"]),
      output: Schema.String,
    }),
  ),
})

export const parallelDescription = [
  `Runs 2-${PARALLEL_LIMIT} independent subtasks at once, each in its own subagent session, waits for all of them, and returns every outcome.`,
  `Use it instead of ${name} when a task splits into parts that do not depend on each other: the wall-clock time is roughly the longest subtask instead of the sum.`,
  "Each subtask starts with a fresh context, so give each a self-contained prompt that says exactly what to do and what to return.",
  "Do not run subtasks that write to the same files: parallel edits to shared files conflict.",
  "Each outcome is completed, running (moved to the background; you are notified when it finishes) or error, which carries its failure in place of the output and the sessionID to continue it when there is one.",
  "Set a subtask's output to the fields you need back when you will act on its answer: that is what makes several answers integrable side by side.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.subagent",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const models = yield* Model.Service
    const subagents = yield* SubagentJob.Service

    const resolveModel = Effect.fn("SubagentTool.resolveModel")(function* (input: string) {
      const ref = yield* Effect.try({
        try: () => Model.Ref.parse(input),
        catch: () =>
          new ToolFailure({
            message: `Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`,
          }),
      })
      const model = (yield* models.available()).find(
        (model) => model.providerID === ref.providerID && model.id === ref.id,
      )
      if (model === undefined)
        return yield* new ToolFailure({
          message: `Model "${ref.providerID}/${ref.id}" is not available. Use the models tool to see what is available.`,
        })
      if (ref.variant !== undefined && !model.variants.some((variant) => variant.id === ref.variant))
        return yield* new ToolFailure({
          message:
            model.variants.length === 0
              ? `Model "${ref.providerID}/${ref.id}" has no variants. Omit the variant.`
              : `Variant "${ref.variant}" is not available for "${ref.providerID}/${ref.id}". Available: ${model.variants.map((variant) => variant.id).join(", ")}.`,
        })
      return ref
    })

    // Depth and agent checks, before anything is created. A fan-out runs them for every subtask first,
    // so a bad entry never leaves sessions behind for its siblings.
    const prepare = Effect.fn("SubagentTool.prepare")(function* (agentName: string, context: Tool.Context) {
      const parent = yield* sessions
        .get(context.sessionID)
        .pipe(
          Effect.mapError(
            (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
          ),
        )
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions
          .get(current.parentID)
          .pipe(
            Effect.mapError(
              (error) => new ToolFailure({ message: `Parent session not found: ${current.parentID}`, error }),
            ),
          )
      }
      const limit = Config.latest(yield* config.entries(), "experimental")?.subagent_depth ?? 1
      if (depth >= limit)
        return yield* new ToolFailure({
          message: `Subagent depth limit reached (${limit}). Increase "experimental.subagent_depth" to allow nested subagents.`,
        })
      const agent = yield* agents.resolve(agentName)
      if (agent === undefined) return yield* new ToolFailure({ message: `Unknown agent: ${agentName}` })
      if (agent.mode === "primary")
        return yield* new ToolFailure({ message: `Agent ${agentName} cannot run as a subagent` })
      return { parent, agent }
    })

    const authorize = (agent: Agent.Info, context: Tool.Context) =>
      permission
        .assert({
          action: name,
          resources: [agent.id],
          save: [agent.id],
          sessionID: context.sessionID,
          agent: context.agent,
          source: {
            type: "tool",
            messageID: context.messageID,
            id: context.id,
          },
        })
        .pipe(Effect.mapError((error) => new ToolFailure({ message: `Subagent denied: ${agent.id}`, error })))

    const launch = Effect.fn("SubagentTool.launch")(function* (
      input: typeof Input.Type,
      context: Tool.Context,
      prepared: Effect.Success<ReturnType<typeof prepare>>,
    ) {
      const parent = prepared.parent
      const agent = prepared.agent
      const existing =
        input.sessionID === undefined
          ? undefined
          : yield* sessions
              .get(input.sessionID)
              .pipe(
                Effect.mapError(
                  (error) => new ToolFailure({ message: `Subagent session not found: ${input.sessionID}`, error }),
                ),
              )
      if (existing !== undefined && existing.parentID !== context.sessionID)
        return yield* new ToolFailure({
          message: `Session ${existing.id} is not a child of the current session`,
        })
      const override = input.model === undefined ? undefined : yield* resolveModel(input.model)
      // Continuing with a different agent switches the child, mirroring create semantics
      // where an explicit model wins over the agent's configured model, which wins over the inherited one.
      if (existing !== undefined) {
        const switched = existing.agent !== agent.id
        const model = override ?? (switched ? agent.model : undefined)
        yield* Effect.all([
          switched ? sessions.switchAgent({ sessionID: existing.id, agent: agent.id }) : Effect.void,
          model === undefined ? Effect.void : sessions.switchModel({ sessionID: existing.id, model }),
        ]).pipe(
          Effect.mapError(
            (error) => new ToolFailure({ message: `Failed to switch subagent session: ${existing.id}`, error }),
          ),
        )
      }

      const model = override ?? agent.model ?? parent.model
      const child =
        existing ??
        (yield* sessions
          .create({
            parentID: context.sessionID,
            title: input.description,
            agent: agent.id,
            model,
          })
          .pipe(
            Effect.mapError(
              (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
            ),
          ))

      const background = input.background === true
      yield* context.progress({ sessionID: child.id, status: "running" })

      // Standard prompt admission outside the job: Job.start joining a running child skips
      // its run effect, and the default wake starts an idle child or steers a running one.
      yield* sessions
        .prompt({
          sessionID: child.id,
          text: [
            ...(existing === undefined ? ["You are a subagent spawned by another session."] : []),
            input.prompt,
            ...(input.output?.length ? ["", SubagentOutput.instruction(input.output)] : []),
          ].join("\n"),
          ...(background && existing === undefined ? { resume: false } : {}),
        })
        .pipe(Effect.mapError((error) => new ToolFailure({ message: `Failed to prompt subagent: ${child.id}`, error })))

      const recovery = {
        kind: "subagent" as const,
        parentSessionID: context.sessionID,
        childSessionID: child.id,
        agent: agent.name,
        description: input.description,
        ...(input.output?.length ? { output: input.output } : {}),
      }
      yield* subagents.start(recovery)

      if (background) {
        yield* subagents.background(recovery)
        return backgroundResult(child.id)
      }

      const result = yield* jobs.block({ id: child.id, sessionID: context.sessionID }).pipe(
        Effect.onInterrupt(() =>
          Effect.all([sessions.interrupt(child.id), jobs.cancel(child.id)], {
            discard: true,
          }),
        ),
      )
      if (result?.type === "backgrounded") {
        yield* subagents.notify(recovery, result.info.started_at)
        return backgroundResult(child.id)
      }
      // Failure surfaces keep the sessionID visible so the model can continue the child.
      if (result?.info.status === "error")
        return yield* new ToolFailure({
          message: `Subagent failed (sessionID: ${child.id}): ${result.info.error ?? "unknown error"}`,
        })
      if (result?.info.status === "cancelled")
        return yield* new ToolFailure({ message: `Subagent cancelled (sessionID: ${child.id})` })
      const checked = SubagentCompletion.declared(
        result?.info.output ?? SubagentCompletion.NO_TEXT,
        input.output,
        child.id,
      )
      if (!checked.ok) return yield* new ToolFailure({ message: checked.message })
      return {
        sessionID: child.id,
        status: "completed" as const,
        output: checked.text,
      }
    })

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const prepared = yield* prepare(input.agent, context)
              yield* authorize(prepared.agent, context)
              return yield* launch(input, context, prepared)
            }).pipe(
              Effect.map((output) => ({
                output,
                content:
                  output.status === "completed"
                    ? `<subagent sessionID="${output.sessionID}" state="completed">\n${output.output}\n</subagent>`
                    : output.output,
                metadata: { sessionID: output.sessionID, status: output.status },
              })),
            ),
        })
        // Visible wherever the subagent tool is: a rule that hides one hides both.
        editor.add({
          name: parallelName,
          options: { codemode: false, permission: name },
          description: parallelDescription,
          input: ParallelInput,
          output: ParallelOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.tasks.length < 2 || input.tasks.length > PARALLEL_LIMIT)
                return yield* new ToolFailure({
                  message: `tasks must hold between 2 and ${PARALLEL_LIMIT} subtasks; use ${name} for a single one`,
                })
              const prepared = yield* Effect.forEach(input.tasks, (task) => prepare(task.agent, context))
              // Asked one at a time before anything starts, so the person sees one question at a time.
              yield* Effect.forEach(prepared, (item) => authorize(item.agent, context), { discard: true })
              const tasks = yield* Effect.forEach(
                input.tasks,
                (task, index) =>
                  launch(task, context, prepared[index]).pipe(
                    Effect.map((output) => ({
                      description: task.description,
                      sessionID: output.sessionID,
                      state: output.status,
                      output: output.output,
                    })),
                    // One subtask failing is that subtask's outcome; its siblings still report theirs.
                    Effect.catchTag("Tool.Error", (failure) =>
                      Effect.succeed({
                        description: task.description,
                        state: "error" as const,
                        output: failure.message,
                      }),
                    ),
                  ),
                { concurrency: "unbounded" },
              )
              return { tasks }
            }).pipe(
              Effect.map((output) => ({
                output,
                content: [
                  "<subagents>",
                  ...output.tasks.map(
                    (task) =>
                      `<subagent${"sessionID" in task ? ` sessionID="${task.sessionID}"` : ""} state="${task.state}" description="${task.description}">\n${task.output}\n</subagent>`,
                  ),
                  "</subagents>",
                ].join("\n"),
                metadata: {
                  tasks: output.tasks.map((task) => ({
                    ...("sessionID" in task ? { sessionID: task.sessionID } : {}),
                    state: task.state,
                  })),
                },
              })),
            ),
        })
      })
      .pipe(Effect.orDie)

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.sync(() => {
        if (event.tool !== name || !Predicate.isObject(event.input)) return
        if (event.input.model !== "" && event.input.sessionID !== "") return
        const input = { ...event.input }
        if (input.model === "") delete input.model
        if (input.sessionID === "") delete input.sessionID
        event.input = input
      }),
    )

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const tools = [event.tools[name], event.tools[parallelName]].filter((tool) => tool !== undefined)
        if (tools.length === 0) return
        const selected = yield* agents.resolve(event.agent)
        if (!selected) return
        const available = (yield* agents.list())
          .filter(
            (agent) =>
              agent.mode !== "primary" &&
              !agent.hidden &&
              Permission.evaluate(name, agent.id, selected.permissions).effect !== "deny",
          )
          .toSorted((a, b) => a.id.localeCompare(b.id))
        if (available.length === 0) return
        tools.forEach((tool) => {
          tool.description = [
            tool.description,
            "",
            "Available subagents:",
            ...available.map(
              (agent) =>
                `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`,
            ),
          ].join("\n")
        })
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
