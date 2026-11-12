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
import { SubagentJob } from "../../session/subagent-job.js"
import { SubagentOutput } from "../../session/subagent-output.js"

export const name = "subagent"

const backgroundResult = (sessionID: SessionSchema.ID) => ({
  sessionID,
  status: "running" as const,
  output: [
    `The subagent is working in the background (sessionID: ${sessionID}). You will receive a <subagent> message when it goes idle, and again after each later round of work.`,
    "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.",
    "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
    "To send it follow-ups or change its instructions while it runs, call subagent again with this sessionID.",
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
      'NEVER set this unless the user explicitly asks for a particular model or variant. It must be a chat model; image and decision models can\'t run subagents. The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first.',
  }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description: "Send a follow-up to an existing subagent, running or finished. Omit to start a new one.",
  }),
  output: Schema.optionalKey(Schema.Array(SubagentOutput.Field)).annotate({
    description:
      "Fields you need back from the subagent. Set this when you will act on the answer rather than read it: the subagent is told to end with a JSON object carrying exactly these fields, and its <subagent> message reports an error with what it said if it does not, instead of handing you prose to guess at.",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literal("running"),
  output: Schema.String,
})
export const description = [
  "Spawns an agent in a child session to work on the specified task.",
  "Subagents always run in the background: the call returns immediately with a sessionID, and you receive a `<subagent>` message each time the child goes idle, including after later work.",
  "Keep working on non-overlapping tasks, or briefly tell the user what you launched and end your response. Do not sleep, poll for progress, or ask the child for status.",
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  "Pass the returned sessionID to continue that specific child conversation. A follow-up to a running child joins its current run.",
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
      state: Schema.Literals(["running", "error"]),
      output: Schema.String,
    }),
  ),
})

export const parallelDescription = [
  `Starts 2-${PARALLEL_LIMIT} independent subtasks at once, each in its own subagent session running in the background, and returns their sessionIDs. Each one sends you a <subagent> message when it goes idle.`,
  `Use it instead of ${name} when a task splits into parts that do not depend on each other: the wall-clock time is roughly the longest subtask instead of the sum.`,
  "Each subtask starts with a fresh context, so give each a self-contained prompt that says exactly what to do and what to return.",
  "Do not run subtasks that write to the same files: parallel edits to shared files conflict.",
  "Each outcome is running, or error when the subtask could not be started; the error carries its failure in place of the output and the sessionID to continue it when there is one.",
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
      if (model === undefined) {
        const other = (yield* models.available(["image", "decision"])).find(
          (model) => model.providerID === ref.providerID && model.id === ref.id,
        )
        return yield* new ToolFailure({
          message: other
            ? `Model "${ref.providerID}/${ref.id}" is ${other.type === "image" ? "an image" : "a decision"} model; subagents need a chat model. Use the models tool to find one.`
            : `Model "${ref.providerID}/${ref.id}" is not available. Use the models tool to see what is available.`,
        })
      }
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
          ...Permission.invocation(context),
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

      // A child that is not draining yet must be admitted without waking: the job's resume
      // owns the start, so the period cannot run before its boundary is registered.
      const running =
        existing !== undefined &&
        ((yield* sessions.active).has(existing.id) || (yield* jobs.get(existing.id))?.status === "running")
      yield* context.progress({ sessionID: child.id, status: "running" })

      yield* sessions
        .prompt({
          sessionID: child.id,
          text: [
            ...(existing === undefined ? ["You are a subagent spawned by another session."] : []),
            input.prompt,
            ...(input.output?.length ? ["", SubagentOutput.instruction(input.output)] : []),
          ].join("\n"),
          ...(running ? {} : { resume: false }),
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
      // The declared fields travel with the job and are checked when the answer is delivered.
      yield* subagents.start(recovery)
      return backgroundResult(child.id)
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
                content: output.output,
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
