export * as ConfigAgent from "./agent.js"

import { Effect, Schema } from "effect"
import { Permission } from "../permission.js"
import { optional, PositiveInt } from "../schema.js"
import { ConfigModel } from "./model.js"
import { ConfigProvider } from "./provider.js"

export const Color = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/u))

export class Info extends Schema.Class<Info>("Config.Agent")({
  model: ConfigModel.Selection.pipe(optional),
  request: ConfigProvider.Request.pipe(optional),
  system: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  mode: Schema.Literals(["subagent", "primary", "all"]).pipe(optional),
  hidden: Schema.Boolean.pipe(optional),
  // An unsupported color, such as a V1 theme name, should not drop the whole agent.
  color: Color.pipe(
    Schema.catchDecoding(() => Effect.succeedNone),
    optional,
  ),
  steps: PositiveInt.pipe(optional),
  small: Schema.Boolean.pipe(optional).annotate({
    description:
      "Run this agent on the small model: the title agent's model, else a cheaper model of the session's provider. It must call tools and differ from the session model, or the session model is used.",
  }),
  budget: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(optional).annotate({
    description:
      "US dollars this agent may spend in a session before it degrades to the small model. It does not stop the agent; the budget permission can make it ask or stop instead.",
  }),
  budget_stop: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(optional).annotate({
    description:
      "US dollars this agent may spend answering one request. Past it the agent gets one step without tools to summarize what was done and what is left.",
  }),
  disabled: Schema.Boolean.pipe(optional),
  permissions: Permission.Ruleset.pipe(optional),
}) {}
