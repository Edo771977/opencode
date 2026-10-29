export * as ConfigNormalize from "./normalize.js"

import { isDeepStrictEqual } from "node:util"
import { isRecord } from "@opencode/util/record"
import { Option, Schema } from "effect"
import { Info } from "@opencode/schema/config"
import { ConfigAgent } from "@opencode/schema/config/agent"
import { ConfigCommand } from "@opencode/schema/config/command"
import { ConfigCompaction } from "@opencode/schema/config/compaction"
import { ConfigFormatter } from "@opencode/schema/config/formatter"
import { ConfigLSP } from "@opencode/schema/config/lsp"
import { ConfigMedia } from "@opencode/schema/config/media"
import { ConfigModel } from "@opencode/schema/config/model"
import { ConfigMCP } from "@opencode/schema/config/mcp"
import { ConfigPlugin } from "@opencode/schema/config/plugin"
import { ConfigPolicy } from "@opencode/schema/config/policy"
import { ConfigProvider } from "@opencode/schema/config/provider"
import { ConfigReference } from "@opencode/schema/config/reference"
import { ConfigExperimental } from "@opencode/schema/config/experimental"
import { Permission } from "@opencode/schema/permission"
import { ConfigAgentV1 } from "../v1/config/agent.js"
import { ConfigCommandV1 } from "../v1/config/command.js"
import { ConfigMCPV1 } from "../v1/config/mcp.js"
import { ConfigPermissionV1 } from "../v1/config/permission.js"
import { ConfigPluginV1 } from "../v1/config/plugin.js"
import { ConfigProviderV1 } from "../v1/config/provider.js"
import { ConfigMigrateV1 } from "../v1/config/migrate.js"
import { PositiveInt } from "../schema.js"

export interface Diagnostic {
  readonly kind: "conflict" | "invalid" | "unsupported"
  readonly path: readonly string[]
  readonly message: string
}

export type Result =
  | {
      readonly type: "normalized"
      readonly encoded: Readonly<Record<string, unknown>>
      readonly diagnostics: readonly Diagnostic[]
    }
  | { readonly type: "rejected"; readonly diagnostics: readonly Diagnostic[] }

const options = { errors: "all", onExcessProperty: "ignore" } as const
const unsupportedTopLevel = ["logLevel", "server", "subagent_depth", "layout"] as const
const unsupportedExperimental = [
  "disable_paste_summary",
  "batch_tool",
  "openTelemetry",
  "primary_tools",
  "continue_loop_on_deny",
] as const
const unsupportedProvider = ["id", "whitelist", "blacklist"] as const
const unsupportedModel = ["release_date", "attachment", "reasoning", "temperature", "experimental"] as const
const LegacyAutoupdate = Schema.Literals([true, false, "notify"])

export function normalize(input: unknown): Result {
  if (!isRecord(input))
    return {
      type: "rejected",
      diagnostics: [
        { kind: "invalid", path: ["$"], message: "rejected configuration because its root is not an object" },
      ],
    }

  const diagnostics: Diagnostic[] = []
  const encoded: Record<string, unknown> = {}
  unsupportedTopLevel.forEach((key) => unsupportedIfPresent(input, key, [key], diagnostics))

  const legacySnapshots = own(input, "snapshot")
    ? decodeEncoded(Schema.Boolean, input.snapshot, ["snapshot"], diagnostics)
    : undefined
  const legacyUpdate = own(input, "autoupdate")
    ? decodeValue(LegacyAutoupdate, input.autoupdate, ["autoupdate"], diagnostics)
    : undefined
  const nativeUpdate = own(input, "update")
    ? decodeEncoded(Info.fields.update, input.update, ["update"], diagnostics)
    : undefined
  const legacyShare = own(input, "autoshare")
    ? decodeValue(Schema.Boolean, input.autoshare, ["autoshare"], diagnostics) === true
      ? "auto"
      : undefined
    : undefined
  const legacyMedia = own(input, "attachment")
    ? decodeEncoded(ConfigMedia.Info, input.attachment, ["attachment"], diagnostics)
    : undefined
  if (legacyMedia !== undefined) encoded.media = legacyMedia
  if (legacySnapshots !== undefined) encoded.snapshots = legacySnapshots
  const migratedUpdate =
    legacyUpdate === false
      ? "disable"
      : legacyUpdate === "notify"
        ? "notify"
        : legacyUpdate === true
          ? "auto"
          : undefined
  const update = prefer(migratedUpdate, nativeUpdate, own(input, "update"), ["update"], diagnostics)
  if (update !== undefined) encoded.update = update
  if (legacyShare !== undefined) encoded.share = legacyShare

  const legacyReferences = decodeMap(input.reference, ConfigReference.Entry, ["reference"], diagnostics, decodeEncoded)
  const nativeReferences = decodeMap(
    input.references,
    ConfigReference.Entry,
    ["references"],
    diagnostics,
    decodeEncoded,
  )
  mergeMap(
    encoded,
    "references",
    legacyReferences,
    nativeReferences,
    isRecord(input.reference) || isRecord(input.references),
    diagnostics,
    input.references,
  )

  const legacyCommands = decodeMap(input.command, ConfigCommandV1.Info, ["command"], diagnostics, decodeValue)
  diagnoseSelectionMap(input.command, ["command"], diagnostics)
  const migratedCommands = mapValues(legacyCommands, (value) =>
    canonical(ConfigCommand.Info, ConfigMigrateV1.migrateCommand(value)),
  )
  const nativeCommands = decodeMap(input.commands, ConfigCommand.Info, ["commands"], diagnostics, decodeEncoded)
  mergeMap(
    encoded,
    "commands",
    migratedCommands,
    nativeCommands,
    isRecord(input.command) || isRecord(input.commands),
    diagnostics,
    input.commands,
  )

  const legacyAgents = mapValues(
    decodeMap(input.agent, ConfigAgentV1.Info, ["agent"], diagnostics, decodeValue),
    (value) => canonical(ConfigAgent.Info, ConfigMigrateV1.migrateAgent(value)),
  )
  const legacySmallModel = own(input, "small_model")
    ? decodeValue(Schema.String, input.small_model, ["small_model"], diagnostics)
    : undefined
  const migratedSmallModel = ConfigMigrateV1.modelSelection(legacySmallModel)
  if (legacySmallModel && !migratedSmallModel)
    diagnostics.push({
      kind: "unsupported",
      path: ["small_model"],
      message: "omitted unsupported legacy model reference",
    })
  if (migratedSmallModel)
    legacyAgents.title = {
      model: migratedSmallModel,
      ...legacyAgents.title,
    }
  const modeAgents = mapValues(decodeMap(input.mode, ConfigAgentV1.Info, ["mode"], diagnostics, decodeValue), (value) =>
    canonical(ConfigAgent.Info, ConfigMigrateV1.migrateAgent({ ...value, mode: "primary" })),
  )
  const migratedAgents = mergeMaps(legacyAgents, modeAgents, ["agents"], diagnostics, input.mode)
  const nativeAgents = decodeMap(input.agents, ConfigAgent.Info, ["agents"], diagnostics, decodeEncoded)
  diagnoseAgentUnsupported(input.agent, ["agent"], diagnostics)
  diagnoseAgentUnsupported(input.mode, ["mode"], diagnostics)
  mergeMap(
    encoded,
    "agents",
    migratedAgents,
    nativeAgents,
    migratedSmallModel !== undefined || isRecord(input.agent) || isRecord(input.mode) || isRecord(input.agents),
    diagnostics,
    input.agents,
  )

  const legacyProviders = migrateProviders(input.provider, diagnostics)
  const nativeProviders = decodeMap(input.providers, ConfigProvider.Info, ["providers"], diagnostics, decodeEncoded)
  mergeMap(
    encoded,
    "providers",
    legacyProviders,
    nativeProviders,
    isRecord(input.provider) || isRecord(input.providers),
    diagnostics,
    input.providers,
  )

  const permissions = [
    ...migrateTools(input.tools, diagnostics),
    ...migratePermissions(input.permission, diagnostics),
    ...nativePermissions(input.permissions, diagnostics),
  ]
  if (permissions.length || Array.isArray(input.permissions)) encoded.permissions = permissions

  const legacyPlugins = decodeList(input.plugin, ConfigPluginV1.Spec, ["plugin"], diagnostics, decodeValue).map(
    (plugin) => (typeof plugin === "string" ? plugin : { package: plugin[0], options: plugin[1] }),
  )
  const nativePlugins = decodeList(input.plugins, ConfigPlugin.Plugin, ["plugins"], diagnostics, decodeEncoded)
  if (legacyPlugins.length || nativePlugins.length || Array.isArray(input.plugin) || Array.isArray(input.plugins))
    encoded.plugins = [...legacyPlugins, ...nativePlugins]

  normalizeSkills(input, encoded, diagnostics)
  normalizeMcp(input, encoded, diagnostics)
  normalizeCompaction(input, encoded, diagnostics)
  normalizePolicies(input, encoded, diagnostics)
  normalizeExperimental(input, encoded, diagnostics)
  normalizeWatcher(input, encoded, diagnostics)
  normalizeFormatter(input, encoded, diagnostics)
  normalizeLsp(input, encoded, diagnostics)

  const model = own(input, "model")
    ? decodeValue(ConfigModel.Selection, input.model, ["model"], diagnostics)
    : undefined
  if (model) encoded.model = { ...model, providerID: ConfigMigrateV1.providerID(model.providerID) }

  const nativeAtomic = {
    $schema: Info.fields.$schema,
    shell: Info.fields.shell,
    default_agent: Info.fields.default_agent,
    share: Info.fields.share,
    enterprise: Info.fields.enterprise,
    username: Info.fields.username,
    timezone: Info.fields.timezone,
    snapshots: Info.fields.snapshots,
    media: Info.fields.media,
    tool_output: Info.fields.tool_output,
    websearch: Info.fields.websearch,
    worktree: Info.fields.worktree,
    warming: Info.fields.warming,
  }
  Object.entries(nativeAtomic).forEach(([key, schema]) => {
    if (!own(input, key)) return
    const value = decodeEncoded(schema, input[key], [key], diagnostics)
    if (value === undefined) {
      // A malformed setting must not let the legacy one it overrides through: `share: "sometimes"`
      // beside `autoshare: true` would otherwise turn on automatic sharing.
      if (own(encoded, key)) dropFallback(encoded, key, [key], diagnostics)
      return
    }
    overlay(encoded, key, value, [key], diagnostics)
  })

  const instructions = decodeList(input.instructions, Schema.String, ["instructions"], diagnostics, decodeEncoded)
  if (instructions.length || Array.isArray(input.instructions)) encoded.instructions = instructions

  return { type: "normalized", encoded, diagnostics }
}

function normalizeSkills(input: Record<string, unknown>, encoded: Record<string, unknown>, diagnostics: Diagnostic[]) {
  if (!own(input, "skills")) return
  if (Array.isArray(input.skills)) {
    encoded.skills = decodeList(input.skills, Schema.String, ["skills"], diagnostics, decodeEncoded)
    return
  }
  if (!isRecord(input.skills)) {
    invalid(["skills"], diagnostics)
    return
  }
  encoded.skills = [
    ...decodeList(input.skills.paths, Schema.String, ["skills", "paths"], diagnostics, decodeEncoded),
    ...decodeList(input.skills.urls, Schema.String, ["skills", "urls"], diagnostics, decodeEncoded),
  ]
}

function normalizeMcp(input: Record<string, unknown>, encoded: Record<string, unknown>, diagnostics: Diagnostic[]) {
  const legacyServers: Record<string, unknown> = {}
  const nativeServers: Record<string, unknown> = {}
  const timeout: Record<string, unknown> = {}
  if (isRecord(input.experimental) && own(input.experimental, "mcp_timeout")) {
    const value = decodeEncoded(
      PositiveInt,
      input.experimental.mcp_timeout,
      ["experimental", "mcp_timeout"],
      diagnostics,
    )
    // V1 never applied this to connecting, unlike a per-server timeout.
    if (value !== undefined) {
      timeout.catalog = value
      timeout.execution = value
    }
  }
  if (own(input, "mcp")) {
    if (!isRecord(input.mcp)) invalid(["mcp"], diagnostics)
    if (isRecord(input.mcp)) {
      Object.entries(input.mcp).forEach(([name, value]) => {
        const path = ["mcp", name]
        if (isEnabledOnlyMcp(value)) {
          diagnostics.push({ kind: "unsupported", path, message: "omitted enabled-only legacy MCP entry" })
          return
        }
        if (name === "servers" && !isDirectLegacyMcp(value)) {
          Object.entries(
            decodeMap(expandServerTimeouts(value), ConfigMCP.Server, path, diagnostics, decodeEncoded),
          ).forEach(([key, server]) => setOwn(nativeServers, key, server))
          return
        }
        if (name === "timeout" && !isDirectLegacyMcp(value)) {
          normalizeMcpTimeout(
            typeof value === "number" ? ConfigMigrateV1.migrateMcpTimeout(value) : value,
            timeout,
            path,
            diagnostics,
          )
          return
        }
        const server = decodeValue(ConfigMCPV1.Info, value, path, diagnostics)
        if (server !== undefined)
          setOwn(legacyServers, name, canonical(ConfigMCP.Server, ConfigMigrateV1.migrateMcp(server)))
      })
    }
  }
  const authoredServers =
    isRecord(input.mcp) && !isDirectLegacyMcp(input.mcp.servers) && !isEnabledOnlyMcp(input.mcp.servers)
      ? input.mcp.servers
      : undefined
  const servers = mergeMaps(legacyServers, nativeServers, ["mcp", "servers"], diagnostics, authoredServers)
  if (!Object.keys(servers).length && !Object.keys(timeout).length) {
    if (isRecord(input.mcp) && !Object.keys(input.mcp).length) encoded.mcp = {}
    return
  }
  encoded.mcp = {
    ...(Object.keys(timeout).length ? { timeout } : {}),
    ...(Object.keys(servers).length ? { servers } : {}),
  }
}

// Native servers accept the V1 bare-number timeout so one V1-shaped field does not drop the whole server.
function expandServerTimeouts(value: unknown) {
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([name, server]) => [
      name,
      isRecord(server) && typeof server.timeout === "number"
        ? { ...server, timeout: ConfigMigrateV1.migrateMcpTimeout(server.timeout) }
        : server,
    ]),
  )
}

function normalizeMcpTimeout(
  value: unknown,
  timeout: Record<string, unknown>,
  path: string[],
  diagnostics: Diagnostic[],
) {
  if (!isRecord(value)) {
    invalid(path, diagnostics)
    return
  }
  const recognized = Object.entries(ConfigMCP.Timeout.fields).filter(([key]) => own(value, key))
  if (Object.keys(value).length && !recognized.length) {
    invalid(path, diagnostics)
    return
  }
  recognized.forEach(([key, field]) => {
    const leaf = decodeEncoded(field, value[key], [...path, key], diagnostics)
    if (leaf === undefined) return
    overlay(timeout, key, leaf, [...path, key], diagnostics)
  })
}

function normalizeCompaction(
  input: Record<string, unknown>,
  encoded: Record<string, unknown>,
  diagnostics: Diagnostic[],
) {
  if (!own(input, "compaction")) return
  if (!isRecord(input.compaction)) {
    invalid(["compaction"], diagnostics)
    return
  }
  unsupportedIfPresent(input.compaction, "tail_turns", ["compaction", "tail_turns"], diagnostics)
  unsupportedIfPresent(input.compaction, "prune", ["compaction", "prune"], diagnostics)
  const result: Record<string, unknown> = {}
  if (own(input.compaction, "auto")) {
    const value = decodeEncoded(
      ConfigCompaction.Info.fields.auto,
      input.compaction.auto,
      ["compaction", "auto"],
      diagnostics,
    )
    if (value !== undefined) result.auto = value
  }
  const legacyTokens = own(input.compaction, "preserve_recent_tokens")
    ? decodeEncoded(
        ConfigCompaction.Keep.fields.tokens,
        input.compaction.preserve_recent_tokens,
        ["compaction", "preserve_recent_tokens"],
        diagnostics,
      )
    : undefined
  const nativeKeep = isRecord(input.compaction.keep) ? input.compaction.keep : undefined
  if (own(input.compaction, "keep") && !nativeKeep) invalid(["compaction", "keep"], diagnostics)
  const nativeTokens =
    nativeKeep && own(nativeKeep, "tokens")
      ? decodeEncoded(
          ConfigCompaction.Keep.fields.tokens,
          nativeKeep.tokens,
          ["compaction", "keep", "tokens"],
          diagnostics,
        )
      : undefined
  const tokens = prefer(
    legacyTokens,
    nativeTokens,
    own(input.compaction, "keep") && (!nativeKeep || own(nativeKeep, "tokens")),
    ["compaction", "keep", "tokens"],
    diagnostics,
  )
  if (tokens !== undefined) result.keep = { tokens }
  const legacyBuffer = own(input.compaction, "reserved")
    ? decodeEncoded(
        ConfigCompaction.Info.fields.buffer,
        input.compaction.reserved,
        ["compaction", "reserved"],
        diagnostics,
      )
    : undefined
  const nativeBuffer = own(input.compaction, "buffer")
    ? decodeEncoded(ConfigCompaction.Info.fields.buffer, input.compaction.buffer, ["compaction", "buffer"], diagnostics)
    : undefined
  const buffer = prefer(
    legacyBuffer,
    nativeBuffer,
    own(input.compaction, "buffer"),
    ["compaction", "buffer"],
    diagnostics,
  )
  if (buffer !== undefined) result.buffer = buffer
  if (Object.keys(result).length || !Object.keys(input.compaction).length) encoded.compaction = result
}

// V1 provider lists and `experimental.policies` stay supported and merge into
// top-level `policies`; within a document, later sources win ties.
function normalizePolicies(
  input: Record<string, unknown>,
  encoded: Record<string, unknown>,
  diagnostics: Diagnostic[],
) {
  const generated: unknown[] = []
  const enabled = decodeProviderList(input, "enabled_providers", diagnostics)
  if (enabled.present && (!enabled.nonEmpty || enabled.values.length)) {
    generated.push({ action: "provider.use", resource: "*", effect: "deny" })
    generated.push(
      ...enabled.values.map((resource) => ({
        action: "provider.use",
        resource: ConfigMigrateV1.providerID(resource),
        effect: "allow",
      })),
    )
  }
  const disabled = decodeProviderList(input, "disabled_providers", diagnostics)
  generated.push(
    ...disabled.values.map((resource) => ({
      action: "provider.use",
      resource: ConfigMigrateV1.providerID(resource),
      effect: "deny",
    })),
  )
  const experimental = isRecord(input.experimental)
    ? policies(input.experimental.policies, ["experimental", "policies"], diagnostics)
    : []
  const native = policies(input.policies, ["policies"], diagnostics)
  if (
    generated.length ||
    experimental.length ||
    native.length ||
    Array.isArray(input.policies) ||
    (isRecord(input.experimental) && Array.isArray(input.experimental.policies))
  )
    encoded.policies = [...generated, ...experimental, ...native]
}

function normalizeExperimental(
  input: Record<string, unknown>,
  encoded: Record<string, unknown>,
  diagnostics: Diagnostic[],
) {
  const result: Record<string, unknown> = {}
  if (own(input, "experimental")) {
    if (!isRecord(input.experimental)) invalid(["experimental"], diagnostics)
    if (isRecord(input.experimental)) {
      const experimental = input.experimental
      unsupportedExperimental.forEach((key) =>
        unsupportedIfPresent(experimental, key, ["experimental", key], diagnostics),
      )
      if (own(experimental, "portable_shell_scanner")) {
        const value = decodeEncoded(
          ConfigExperimental.Info.fields.portable_shell_scanner,
          experimental.portable_shell_scanner,
          ["experimental", "portable_shell_scanner"],
          diagnostics,
        )
        if (value !== undefined) result.portable_shell_scanner = value
      }
      if (own(experimental, "todo")) {
        const value = decodeEncoded(
          ConfigExperimental.Info.fields.todo,
          experimental.todo,
          ["experimental", "todo"],
          diagnostics,
        )
        if (value !== undefined) result.todo = value
      }
      if (own(experimental, "background_compaction")) {
        const value = decodeEncoded(
          ConfigExperimental.Info.fields.background_compaction,
          experimental.background_compaction,
          ["experimental", "background_compaction"],
          diagnostics,
        )
        if (value !== undefined) result.background_compaction = value
      }
      if (own(experimental, "media_blob")) {
        const value = decodeEncoded(
          ConfigExperimental.Info.fields.media_blob,
          experimental.media_blob,
          ["experimental", "media_blob"],
          diagnostics,
        )
        if (value !== undefined) result.media_blob = value
      }
      if (own(experimental, "image_generate")) {
        const value = decodeEncoded(
          ConfigExperimental.Info.fields.image_generate,
          experimental.image_generate,
          ["experimental", "image_generate"],
          diagnostics,
        )
        if (value !== undefined) result.image_generate = value
      }
      if (own(experimental, "schedules")) {
        const value = decodeEncoded(
          ConfigExperimental.Info.fields.schedules,
          experimental.schedules,
          ["experimental", "schedules"],
          diagnostics,
        )
        if (value !== undefined) result.schedules = value
      }
      if (own(experimental, "subagent_depth")) {
        const value = decodeEncoded(
          ConfigExperimental.Info.fields.subagent_depth,
          experimental.subagent_depth,
          ["experimental", "subagent_depth"],
          diagnostics,
        )
        if (value !== undefined) result.subagent_depth = value
      }
      if (own(experimental, "location_idle_timeout")) {
        const value = decodeEncoded(
          ConfigExperimental.Info.fields.location_idle_timeout,
          experimental.location_idle_timeout,
          ["experimental", "location_idle_timeout"],
          diagnostics,
        )
        if (value !== undefined) result.location_idle_timeout = value
      }
    }
  }
  if (Object.keys(result).length || (isRecord(input.experimental) && !Object.keys(input.experimental).length))
    encoded.experimental = result
}

function normalizeWatcher(input: Record<string, unknown>, encoded: Record<string, unknown>, diagnostics: Diagnostic[]) {
  if (!own(input, "watcher")) return
  if (!isRecord(input.watcher)) {
    invalid(["watcher"], diagnostics)
    return
  }
  const ignore = decodeList(input.watcher.ignore, Schema.String, ["watcher", "ignore"], diagnostics, decodeEncoded)
  encoded.watcher = ignore.length || Array.isArray(input.watcher.ignore) ? { ignore } : {}
}

function normalizeFormatter(
  input: Record<string, unknown>,
  encoded: Record<string, unknown>,
  diagnostics: Diagnostic[],
) {
  if (!own(input, "formatter")) return
  if (typeof input.formatter === "boolean") {
    const value = decodeEncoded(ConfigFormatter.Info, input.formatter, ["formatter"], diagnostics)
    if (value !== undefined) encoded.formatter = value
    return
  }
  const entries = decodeMap(input.formatter, ConfigFormatter.Entry, ["formatter"], diagnostics, decodeEncoded)
  if (isRecord(input.formatter) && (!Object.keys(input.formatter).length || Object.keys(entries).length))
    encoded.formatter = entries
}

function normalizeLsp(input: Record<string, unknown>, encoded: Record<string, unknown>, diagnostics: Diagnostic[]) {
  if (!own(input, "lsp")) return
  if (typeof input.lsp === "boolean") {
    const value = decodeEncoded(ConfigLSP.Info, input.lsp, ["lsp"], diagnostics)
    if (value !== undefined) encoded.lsp = value
    return
  }
  const entries = decodeMap(input.lsp, ConfigLSP.Entry, ["lsp"], diagnostics, decodeEncoded)
  if (isRecord(input.lsp) && (!Object.keys(input.lsp).length || Object.keys(entries).length)) encoded.lsp = entries
}

// A permission rule or policy that cannot be read becomes a deny over whatever it names, in its own
// place. Dropping it would leave the decision to the rules around it, which are more permissive than
// a denial the file may have meant, and dropping the whole ruleset would hand it to the defaults.
// Rules match last, so a later allowance still overrides the deny as it would have overridden the
// rule as written.
function migrateTools(value: unknown, diagnostics: Diagnostic[]) {
  if (value === undefined) return []
  if (!isRecord(value)) return unreadableRuleset(value, ["tools"], diagnostics)
  return Object.entries(value).map(([key, raw]) => {
    const action = ConfigMigrateV1.normalizeAction(key)
    if (typeof raw !== "boolean") return denyUnreadable(action, "*", ["tools", key], diagnostics)
    return { action, resource: "*", effect: raw ? "allow" : "deny" }
  })
}

function migratePermissions(value: unknown, diagnostics: Diagnostic[]) {
  if (value === undefined) return []
  if (typeof value === "string") {
    const effect = permissionEffect(value)
    return [
      effect === undefined
        ? denyUnreadable("*", "*", ["permission"], diagnostics)
        : { action: "*", resource: "*", effect },
    ]
  }
  if (!isRecord(value)) return unreadableRuleset(value, ["permission"], diagnostics)
  return Object.entries(value).flatMap(([key, raw]) => {
    const action = ConfigMigrateV1.normalizeAction(key)
    if (typeof raw === "string") {
      const effect = permissionEffect(raw)
      return [
        effect === undefined
          ? denyUnreadable(action, "*", ["permission", key], diagnostics)
          : { action, resource: "*", effect },
      ]
    }
    if (!isRecord(raw)) return [denyUnreadable(action, "*", ["permission", key], diagnostics)]
    // The diagnostic names the rule by position: a resource key can hold a secret.
    return Object.entries(raw).map(([resource, rawEffect], index) => {
      const effect = permissionEffect(rawEffect)
      return effect === undefined
        ? denyUnreadable(action, resource, ["permission", key, String(index)], diagnostics)
        : { action, resource, effect }
    })
  })
}

function nativePermissions(value: unknown, diagnostics: Diagnostic[]) {
  if (value === undefined) return []
  if (!Array.isArray(value)) return unreadableRuleset(value, ["permissions"], diagnostics)
  return value.map(
    (item, index) =>
      decodeQuietly(Permission.Rule, item) ??
      denyUnreadable(named(item, "action"), named(item, "resource"), ["permissions", String(index)], diagnostics),
  )
}

// Unknown actions are skipped, so that this client still reads a policy file written for a newer one.
// A known action is one this client enforces, and a policy for it that cannot be read is denied.
function policies(value: unknown, path: string[], diagnostics: Diagnostic[]) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    invalid(path, diagnostics)
    return []
  }
  const known = Schema.is(ConfigPolicy.Info.fields.action)
  return value.flatMap((item, index) => {
    const entry = [...path, String(index)]
    const policy = decodeQuietly(ConfigPolicy.Info, item)
    if (policy !== undefined) return [policy]
    const action = isRecord(item) ? item.action : undefined
    if (!known(action)) {
      invalid(entry, diagnostics)
      return []
    }
    return [denyUnreadable(action, named(item, "resource"), entry, diagnostics)]
  })
}

function permissionEffect(value: unknown) {
  return Option.getOrUndefined(Schema.decodeUnknownOption(ConfigPermissionV1.Action, options)(value))
}

function named(item: unknown, key: string) {
  return isRecord(item) && typeof item[key] === "string" ? item[key] : "*"
}

function denyUnreadable(action: string, resource: string, path: string[], diagnostics: Diagnostic[]) {
  diagnostics.push({ kind: "invalid", path, message: "denied what a malformed rule covers" })
  return { action, resource, effect: "deny" as const }
}

// A root of the wrong kind says nothing about which rules it meant, so it denies everything, unless it
// is empty: an empty container hides no rule.
function unreadableRuleset(value: unknown, path: string[], diagnostics: Diagnostic[]) {
  if ((isRecord(value) || Array.isArray(value)) && !Object.keys(value).length) {
    invalid(path, diagnostics)
    return []
  }
  return [denyUnreadable("*", "*", path, diagnostics)]
}

function migrateProviders(value: unknown, diagnostics: Diagnostic[]) {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    invalid(["provider"], diagnostics)
    return {}
  }
  const candidates = Object.entries(value).flatMap(([name, raw]) => {
    const path = ["provider", name]
    diagnoseProviderUnsupported(raw, path, diagnostics)
    if (invalidProviderOverlays(raw, path, diagnostics)) return []
    const provider = decodeValue(ConfigProviderV1.Info, raw, path, diagnostics)
    if (provider === undefined) return []
    const destination = ConfigMigrateV1.providerID(name)
    return [
      {
        name,
        destination,
        provider: canonical(ConfigProvider.Info, ConfigMigrateV1.migrateProvider(name, provider)),
      },
    ]
  })
  // The canonical name outranks a retired alias for the same provider whether or not it reads: a
  // malformed `azure` must not hand the provider to the `azure-cognitive-services` it replaced.
  const authored = new Set(Object.keys(value).filter((name) => ConfigMigrateV1.providerID(name) === name))
  const current = new Set(candidates.filter((item) => item.name === item.destination).map((item) => item.destination))
  const result: Record<string, unknown> = {}
  candidates.forEach((item) => {
    if (item.name !== item.destination && authored.has(item.destination)) {
      if (!current.has(item.destination))
        diagnostics.push({
          kind: "invalid",
          path: ["provider", item.name],
          message: "dropped the legacy value a malformed setting overrides",
        })
      return
    }
    setOwn(result, item.destination, item.provider)
  })
  return result
}

function invalidProviderOverlays(value: unknown, path: string[], diagnostics: Diagnostic[]) {
  if (!isRecord(value) || !isRecord(value.options)) return false
  const headersInvalid =
    own(value.options, "headers") &&
    (!isPlainRecord(value.options.headers) ||
      Object.values(value.options.headers).some((item) => typeof item !== "string"))
  const bodyInvalid = own(value.options, "body") && !isPlainRecord(value.options.body)
  if (headersInvalid) invalid([...path, "options", "headers"], diagnostics)
  if (bodyInvalid) invalid([...path, "options", "body"], diagnostics)
  return headersInvalid || bodyInvalid
}

function diagnoseProviderUnsupported(value: unknown, path: string[], diagnostics: Diagnostic[]) {
  if (!isRecord(value)) return
  unsupportedProvider.forEach((key) => unsupportedIfPresent(value, key, [...path, key], diagnostics))
  if (!isRecord(value.models)) return
  Object.entries(value.models).forEach(([name, model]) => {
    if (!isRecord(model)) return
    unsupportedModel.forEach((key) => unsupportedIfPresent(model, key, [...path, "models", name, key], diagnostics))
    if (own(model, "status") && model.status !== "deprecated")
      unsupportedIfPresent(model, "status", [...path, "models", name, "status"], diagnostics)
    if (own(model, "interleaved") && typeof model.interleaved === "boolean")
      unsupportedIfPresent(model, "interleaved", [...path, "models", name, "interleaved"], diagnostics)
  })
}

const spendLimits = ["budget", "budget_stop"] as const

function diagnoseAgentUnsupported(value: unknown, path: string[], diagnostics: Diagnostic[]) {
  if (!isRecord(value)) return
  Object.entries(value).forEach(([name, agent]) => {
    if (!isRecord(agent)) return
    unsupportedIfPresent(agent, "name", [...path, name, "name"], diagnostics)
    diagnoseSelection(agent, [...path, name], diagnostics)
    spendLimits.forEach((key) => {
      if (own(agent, key) && !(typeof agent[key] === "number" && agent[key] > 0))
        invalid([...path, name, key], diagnostics)
    })
  })
}

function diagnoseSelectionMap(value: unknown, path: string[], diagnostics: Diagnostic[]) {
  if (!isRecord(value)) return
  Object.entries(value).forEach(([name, entry]) => {
    if (isRecord(entry)) diagnoseSelection(entry, [...path, name], diagnostics)
  })
}

function diagnoseSelection(value: Record<string, unknown>, path: string[], diagnostics: Diagnostic[]) {
  const modelValid = typeof value.model === "string" && /^[^/#]+\/[^#]+$/.test(value.model)
  if (own(value, "model") && typeof value.model === "string" && !modelValid)
    diagnostics.push({
      kind: "unsupported",
      path: [...path, "model"],
      message: "omitted unsupported legacy model reference",
    })
  if (
    own(value, "variant") &&
    typeof value.variant === "string" &&
    (!modelValid || value.variant.length === 0 || value.variant.includes("#"))
  )
    diagnostics.push({
      kind: "unsupported",
      path: [...path, "variant"],
      message: "omitted unsupported legacy model variant",
    })
}

function decodeProviderList(
  input: Record<string, unknown>,
  key: "enabled_providers" | "disabled_providers",
  diagnostics: Diagnostic[],
) {
  if (!own(input, key)) return { present: false, nonEmpty: false, values: [] as string[] }
  if (!Array.isArray(input[key])) {
    invalid([key], diagnostics)
    return { present: true, nonEmpty: true, values: [] as string[] }
  }
  return {
    present: true,
    nonEmpty: input[key].length > 0,
    values: decodeList(input[key], Schema.String, [key], diagnostics, decodeValue),
  }
}

function decodeMap<S extends Schema.Codec<unknown, unknown, never>, A>(
  value: unknown,
  schema: S,
  path: string[],
  diagnostics: Diagnostic[],
  decode: (schema: S, value: unknown, path: string[], diagnostics: Diagnostic[]) => A | undefined,
): Record<string, A> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    invalid(path, diagnostics)
    return {}
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, raw]): [string, A][] => {
      const decoded = decode(schema, raw, [...path, name], diagnostics)
      return decoded === undefined ? [] : [[name, decoded]]
    }),
  )
}

function decodeList<S extends Schema.Codec<unknown, unknown, never>, A>(
  value: unknown,
  schema: S,
  path: string[],
  diagnostics: Diagnostic[],
  decode: (schema: S, value: unknown, path: string[], diagnostics: Diagnostic[]) => A | undefined,
): A[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    invalid(path, diagnostics)
    return []
  }
  return value.flatMap((item, index) => {
    const decoded = decode(schema, item, [...path, String(index)], diagnostics)
    return decoded === undefined ? [] : [decoded]
  })
}

function decodeValue<S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  value: unknown,
  path: string[],
  diagnostics: Diagnostic[],
) {
  const decoded = Schema.decodeUnknownOption(schema, options)(value)
  if (Option.isSome(decoded)) return decoded.value
  invalid(path, diagnostics)
  return undefined
}

function decodeEncoded<S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  value: unknown,
  path: string[],
  diagnostics: Diagnostic[],
) {
  const encoded = decodeQuietly(schema, value)
  if (encoded === undefined) invalid(path, diagnostics)
  return encoded
}

function decodeQuietly<S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: unknown) {
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(
      schema,
      options,
    )(value).pipe(
      Option.flatMap((decoded) => Schema.encodeUnknownOption(schema, options)(decoded)),
      Option.map(plain),
    ),
  )
}

function canonical<S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: unknown) {
  return plain(
    Option.getOrThrow(
      Schema.decodeUnknownOption(
        schema,
        options,
      )(plain(value)).pipe(Option.flatMap((decoded) => Schema.encodeUnknownOption(schema, options)(decoded))),
    ),
  )
}

function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (item === undefined ? [] : [[key, plain(item)]])),
  )
}

function mergeMap(
  target: Record<string, unknown>,
  key: string,
  legacy: Readonly<Record<string, unknown>>,
  native: Readonly<Record<string, unknown>>,
  present: boolean,
  diagnostics: Diagnostic[],
  authored: unknown,
) {
  const merged = mergeMaps(legacy, native, [key], diagnostics, authored)
  if (present) target[key] = merged
}

// `authored` is the native map as written. An entry it names that did not decode, or the whole map
// when it is not one, overrides the legacy entry of the same name all the same: falling back to the
// legacy one would apply a setting the file no longer says.
function mergeMaps(
  legacy: Readonly<Record<string, unknown>>,
  native: Readonly<Record<string, unknown>>,
  path: string[],
  diagnostics: Diagnostic[],
  authored: unknown,
) {
  const result = Object.fromEntries(Object.entries(legacy))
  if (authored !== undefined)
    Object.keys(result)
      .filter((name) => !isRecord(authored) || (own(authored, name) && !own(native, name)))
      .forEach((name) => dropFallback(result, name, [...path, name], diagnostics))
  Object.entries(native).forEach(([name, value]) => {
    if (own(result, name) && !isDeepStrictEqual(result[name], value)) conflict([...path, name], diagnostics)
    setOwn(result, name, value)
  })
  return result
}

function mapValues<A>(input: Readonly<Record<string, A>>, map: (value: A) => unknown) {
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) => {
      const mapped = map(value)
      return mapped === undefined ? [] : [[key, mapped]]
    }),
  )
}

function overlay(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  path: string[],
  diagnostics: Diagnostic[],
) {
  if (own(target, key) && !isDeepStrictEqual(target[key], value)) conflict(path, diagnostics)
  target[key] = value
}

function prefer(legacy: unknown, native: unknown, authored: boolean, path: string[], diagnostics: Diagnostic[]) {
  if (authored && native === undefined) {
    if (legacy !== undefined)
      diagnostics.push({ kind: "invalid", path, message: "dropped the legacy value a malformed setting overrides" })
    return undefined
  }
  if (native === undefined) return legacy
  if (legacy !== undefined && !isDeepStrictEqual(legacy, native)) conflict(path, diagnostics)
  return native
}

function unsupportedIfPresent(value: Record<string, unknown>, key: string, path: string[], diagnostics: Diagnostic[]) {
  if (!own(value, key)) return
  diagnostics.push({ kind: "unsupported", path, message: "omitted unsupported legacy setting" })
}

function dropFallback(target: Record<string, unknown>, key: string, path: string[], diagnostics: Diagnostic[]) {
  delete target[key]
  diagnostics.push({ kind: "invalid", path, message: "dropped the legacy value a malformed setting overrides" })
}

function invalid(path: string[], diagnostics: Diagnostic[]) {
  diagnostics.push({ kind: "invalid", path, message: "skipped malformed recognized value" })
}

function conflict(path: string[], diagnostics: Diagnostic[]) {
  diagnostics.push({ kind: "conflict", path, message: "retained native value over legacy value" })
}

function isDirectLegacyMcp(value: unknown) {
  return isRecord(value) && (value.type === "local" || value.type === "remote")
}

function isEnabledOnlyMcp(value: unknown) {
  return isRecord(value) && !own(value, "type") && typeof value.enabled === "boolean"
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function own(value: Record<string, unknown>, key: string) {
  return Object.hasOwn(value, key)
}

function setOwn(value: Record<string, unknown>, key: string, item: unknown) {
  Object.defineProperty(value, key, { value: item, enumerable: true, configurable: true, writable: true })
}
