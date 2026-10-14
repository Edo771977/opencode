export * as ConfigAgent from "./agent.js"

import { Schema } from "effect"
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
  color: Color.pipe(optional),
  steps: PositiveInt.pipe(optional),
  small: Schema.Boolean.pipe(optional).annotate({
    description:
      "Run this agent on the small model: the title agent's model, else a cheaper model of the session's provider. It must call tools and differ from the session model, or the session model is used.",
  }),
  disabled: Schema.Boolean.pipe(optional),
  permissions: Permission.Ruleset.pipe(optional),
}) {}
