export * as ConfigMigrateV1 from "./migrate"

import { ConfigV1 } from "./config"
import { ConfigAgentV1 } from "./agent"
import { ConfigMCPV1 } from "./mcp"
import { ConfigPermissionV1 } from "./permission"
import { ConfigProviderV1 } from "./provider"
import { ConfigProviderOptionsV1 } from "./provider-options"

const keys = new Set([
  "logLevel",
  "server",
  "command",
  "reference",
  "snapshot",
  "plugin",
  "autoshare",
  "disabled_providers",
  "enabled_providers",
  "mode",
  "agent",
  "provider",
  "permission",
  "tools",
  "attachment",
  "layout",
])

/** Keys only the V2 shape has. Their presence rules a file out of the V1 reading. */
const v2Keys = new Set(["permissions", "agents", "snapshots", "attachments", "commands", "plugins", "providers"])

/**
 * `small_model` belongs to both shapes, so on its own it says nothing about which one a file is,
 * and either reading loses data for the other: V1 files lean on it to keep the V1 reading of
 * `mcp`, `skills` and `compaction`, while a V2 file sent through the V1 parser drops every key in
 * `v2Keys`. Let the rest of the file settle it.
 */
const ambiguous = new Set(["small_model"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Keys both shapes spell the same way but fill differently, judged by shape rather than by name.
 * Reading a V1 shape as V2 loses its contents — every MCP server, the compaction budgets — and for
 * `skills` fails the decode outright, which makes `loadFile` discard the entire file in silence.
 */
const v1Shapes: Record<string, (value: unknown) => boolean> = {
  // V2 takes a flat list of paths and URLs; V1 an object splitting the two.
  skills: (value) => isRecord(value),
  // V2 nests servers under `servers` alongside `timeout`; V1 maps server names at the top level —
  // including, in a V1 file, servers that happen to be named `servers` or `timeout`.
  mcp: (value) =>
    isRecord(value) &&
    (Object.keys(value).some((key) => key !== "servers" && key !== "timeout") ||
      Object.values(value).some(serverEntry)),
  // `auto` and `prune` are shared; the budgets were renamed.
  compaction: (value) =>
    isRecord(value) && ["tail_turns", "preserve_recent_tokens", "reserved"].some((key) => Object.hasOwn(value, key)),
}

/**
 * The V2 shape of those same keys, recognised positively. "Not the V1 shape" is not the same thing:
 * it also describes values both shapes accept, and reading one of those as V2 drops whatever V2 has
 * no place for.
 */
const v2Shapes: Record<string, (value: unknown) => boolean> = {
  skills: (value) => Array.isArray(value),
  // Servers live under `servers`, beside an optional `timeout`. A V1 file may name a server
  // `servers` or `timeout`, and a V1 server entry is recognisable in itself — which is what tells
  // the two readings apart when one of those two names is all that is there.
  mcp: (value) =>
    isRecord(value) &&
    Object.keys(value).length > 0 &&
    Object.keys(value).every((key) => key === "servers" || key === "timeout") &&
    !Object.values(value).some(serverEntry),
  // The budgets V2 renamed. `auto` and `prune` are shared, so they say nothing on their own.
  compaction: (value) => isRecord(value) && (Object.hasOwn(value, "keep") || Object.hasOwn(value, "buffer")),
}

/**
 * A V1 MCP server as written: a local or remote server names its `type`, and an entry that only
 * turns an inherited server off carries `enabled`. Read as values, not as key names — a V2 servers
 * map may hold a server named `type`, whose value is a server rather than a string.
 */
const serverEntry = (value: unknown) =>
  isRecord(value) && (typeof value.type === "string" || typeof value.enabled === "boolean")

// Guarded lookups: an own `__proto__` key in a parsed file would otherwise resolve to
// `Object.prototype` and be called.
const shapedV1 = (input: Record<string, unknown>, key: string) =>
  Object.hasOwn(v1Shapes, key) && v1Shapes[key]?.(input[key]) === true

const shapedV2 = (input: Record<string, unknown>, key: string) =>
  Object.hasOwn(v2Shapes, key) && v2Shapes[key]?.(input[key]) === true

/**
 * Keys a reader has to drop together, because the migration folds them into one setting and keeping
 * one half would mean something the file does not say. A V1 file writes tool allowances as `tools`
 * and qualifies them in `permission`, and both become one ruleset: dropping the half that denies
 * while keeping the half that allows leaves the file more permissive than it reads. The other two
 * are fallbacks, where dropping the key that was written promotes the one it overrode — turning on
 * automatic sharing, or restoring a deprecated spelling, neither of which the file asked for.
 */
const folded = [
  ["permission", "tools"],
  ["share", "autoshare"],
  ["references", "reference"],
]

/** The keys of a file in the units a reader may keep or drop, in the order they were written. */
export function groups(present: readonly string[]) {
  const taken = new Set<string>()
  return present.flatMap((key) => {
    if (taken.has(key)) return []
    const fold = folded.find((group) => group.includes(key))
    if (!fold) return [[key]]
    const group = present.filter((item) => fold.includes(item))
    for (const item of group) taken.add(item)
    return [group]
  })
}

export function isV1(input: unknown) {
  if (!isRecord(input)) return false
  const present = Object.keys(input)
  if (present.some((key) => keys.has(key))) return true
  if (present.some((key) => shapedV1(input, key))) return true
  if (present.some((key) => v2Keys.has(key) || shapedV2(input, key))) return false
  return present.some((key) => ambiguous.has(key))
}

/**
 * The keys a half-migrated file carries under each spelling. One legacy key is enough to send the
 * whole file through the V1 reading, which has nowhere to put the keys only V2 has, so a reader has
 * to take the V1 half from `base`, keep the V2 half as `authored`, and say which came from where.
 */
export function mixed(input: unknown) {
  if (!isRecord(input)) return undefined
  const present = Object.keys(input)
  const legacy = present.filter((key) => keys.has(key) || shapedV1(input, key))
  // A key both shapes spell the same counts as current only when it positively looks like the V2
  // shape: left in, the V1 parser rejects it and takes the rest of the file down with it — but a
  // value that parser reads perfectly well belongs to the half it can read.
  const current = present.filter((key) => v2Keys.has(key) || shapedV2(input, key))
  if (!legacy.length || !current.length) return undefined
  return {
    legacy,
    current,
    authored: Object.fromEntries(current.map((key) => [key, input[key]])),
    base: Object.fromEntries(Object.entries(input).filter(([key]) => !current.includes(key))),
  }
}

/**
 * What a migrated file's keys become once the authored V2 half is laid back over them. Values merge
 * key by key with the authored one winning, so a file that moved one agent — or one field of one
 * agent — to the new spelling keeps everything it still writes in the old. Lists replace: two sets
 * of rules have no meaningful merge.
 */
export function overlay(migrated: Record<string, unknown>, authored: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(authored).map(([key, value]) => [key, merge(migrated[key], value)]))
}

function merge(migrated: unknown, authored: unknown): unknown {
  if (!isRecord(migrated) || !isRecord(authored)) return authored
  return Object.fromEntries([
    ...Object.entries(migrated).filter(([key]) => !Object.hasOwn(authored, key)),
    ...Object.entries(authored).map(([key, value]) => [key, merge(migrated[key], value)]),
  ])
}

export function migrate(info: typeof ConfigV1.Info.Type) {
  return {
    $schema: info.$schema,
    shell: info.shell,
    model: info.model,
    small_model: info.small_model,
    default_agent: info.default_agent,
    autoupdate: info.autoupdate,
    share: info.share ?? (info.autoshare ? "auto" : undefined),
    enterprise: info.enterprise,
    username: info.username,
    permissions: permissions(info.permission, info.tools),
    agents: agents(info),
    snapshots: info.snapshot,
    watcher: info.watcher,
    formatter: info.formatter,
    lsp: info.lsp,
    attachments: info.attachment,
    tool_output: info.tool_output,
    mcp: mcp(info),
    compaction: info.compaction && {
      auto: info.compaction.auto,
      prune: info.compaction.prune,
      keep: {
        tokens: info.compaction.preserve_recent_tokens,
      },
      buffer: info.compaction.reserved,
    },
    skills: info.skills && [...(info.skills.paths ?? []), ...(info.skills.urls ?? [])],
    commands: info.command,
    instructions: info.instructions,
    references: info.references ?? info.reference,
    plugins: info.plugin?.map((plugin) =>
      typeof plugin === "string" ? plugin : { package: plugin[0], options: plugin[1] },
    ),
    // `subagent_depth` was a top-level V1 key and is nested under `experimental` in V2. Both
    // spellings are read, the top-level one winning, which is what the V1 runtime's own
    // compatibility layer does with the same pair.
    experimental: experimental(info),
    providers: providers(info.provider),
  }
}

function experimental(info: typeof ConfigV1.Info.Type) {
  const depth = info.subagent_depth ?? info.experimental?.subagent_depth
  if (!info.experimental?.policies && depth === undefined) return undefined
  return { policies: info.experimental?.policies, subagent_depth: depth }
}

function permissions(info?: ConfigPermissionV1.Info, tools?: Readonly<Record<string, boolean>>) {
  const rules: Array<{ action: string; resource: string; effect: ConfigPermissionV1.Action }> = Object.entries(
    tools ?? {},
  ).map(([action, enabled]) => ({
    action: normalizeAction(action),
    resource: "*",
    effect: enabled ? ("allow" as const) : ("deny" as const),
  }))
  for (const [action, rule] of Object.entries(info ?? {})) {
    if (!rule) continue
    if (typeof rule === "string") {
      rules.push({ action, resource: "*", effect: rule })
      continue
    }
    rules.push(...Object.entries(rule).map(([resource, effect]) => ({ action, resource, effect })))
  }
  return rules.length ? rules : undefined
}

function normalizeAction(action: string) {
  return action === "write" || action === "patch" ? "edit" : action
}

function agents(info: typeof ConfigV1.Info.Type) {
  const entries = [
    ...Object.entries(info.agent ?? {}),
    ...Object.entries(info.mode ?? {}).map(([name, agent]) => [name, { ...agent, mode: "primary" as const }] as const),
  ]
  if (!entries.length) return undefined
  return Object.fromEntries(entries.flatMap(([name, agent]) => (agent ? [[name, migrateAgent(agent)]] : [])))
}

export function migrateAgent(info: ConfigAgentV1.Info) {
  const body = {
    ...info.options,
    ...(info.temperature === undefined ? {} : { temperature: info.temperature }),
    ...(info.top_p === undefined ? {} : { top_p: info.top_p }),
  }
  return {
    model: info.model,
    small: info.small,
    variant: info.variant,
    request: Object.keys(body).length ? { body } : undefined,
    system: info.prompt,
    description: info.description,
    mode: info.mode,
    hidden: info.hidden,
    color: info.color,
    steps: info.steps,
    budget: info.budget,
    budget_stop: info.budget_stop,
    disabled: info.disable,
    permissions: permissions(info.permission),
  }
}

function mcp(info: typeof ConfigV1.Info.Type) {
  const servers = Object.fromEntries(
    Object.entries(info.mcp ?? {}).flatMap(([name, server]) =>
      "type" in server ? [[name, migrateMcp(server)] as const] : [],
    ),
  )
  const timeout = info.experimental?.mcp_timeout
  if (!timeout && !Object.keys(servers).length) return undefined
  return { timeout: timeout === undefined ? undefined : { request: timeout }, servers }
}

function migrateMcp(info: ConfigMCPV1.Info) {
  const disabled = info.enabled === undefined ? undefined : !info.enabled
  if (info.type === "local")
    return {
      type: info.type,
      command: info.command,
      cwd: info.cwd,
      environment: info.environment,
      disabled,
      timeout: info.timeout === undefined ? undefined : { request: info.timeout },
    }
  return {
    type: info.type,
    url: info.url,
    headers: info.headers,
    oauth: info.oauth && {
      client_id: info.oauth.clientId,
      client_secret: info.oauth.clientSecret,
      scope: info.oauth.scope,
      callback_port: info.oauth.callbackPort,
      redirect_uri: info.oauth.redirectUri,
    },
    disabled,
    timeout: info.timeout === undefined ? undefined : { request: info.timeout },
  }
}

function providers(info?: Readonly<Record<string, ConfigProviderV1.Info>>) {
  if (!info) return undefined
  return Object.fromEntries(Object.entries(info).map(([name, provider]) => [name, migrateProvider(provider)]))
}

function migrateProvider(info: ConfigProviderV1.Info) {
  const lowerer = ConfigProviderOptionsV1.get(info.npm)
  const options = lowerer.provider(info.options ?? {})
  const url = info.api ?? options.url
  return {
    name: info.name,
    env: info.env,
    api: info.npm
      ? {
          type: "aisdk" as const,
          package: info.npm,
          ...(url === undefined ? {} : { url }),
          settings: options.settings ?? {},
        }
      : undefined,
    request: info.options && { headers: options.headers, body: options.body },
    models:
      info.models &&
      Object.fromEntries(Object.entries(info.models).map(([name, model]) => [name, migrateModel(model, info.npm)])),
  }
}

function migrateModel(info: typeof ConfigProviderV1.Model.Type, packageName?: string) {
  const packageID = info.provider?.npm ?? packageName
  const lowerer = ConfigProviderOptionsV1.get(packageID)
  const request = info.options && lowerer.request(info.options)
  const costs = info.cost && [
    {
      input: info.cost.input,
      output: info.cost.output,
      cache: { read: info.cost.cache_read, write: info.cost.cache_write },
    },
    ...(info.cost.context_over_200k
      ? [
          {
            tier: { type: "context" as const, size: 200_000 },
            input: info.cost.context_over_200k.input,
            output: info.cost.context_over_200k.output,
            cache: { read: info.cost.context_over_200k.cache_read, write: info.cost.context_over_200k.cache_write },
          },
        ]
      : []),
  ]
  const capabilities =
    info.tool_call !== undefined || info.modalities?.input !== undefined || info.modalities?.output !== undefined
      ? { tools: info.tool_call ?? false, input: info.modalities?.input ?? [], output: info.modalities?.output ?? [] }
      : undefined
  return {
    family: info.family,
    name: info.name,
    api: info.provider?.npm
      ? {
          ...(info.id === undefined ? {} : { id: info.id }),
          type: "aisdk" as const,
          package: info.provider.npm,
          ...(info.provider.api === undefined ? {} : { url: info.provider.api }),
          settings: {},
        }
      : info.id === undefined
        ? undefined
        : { id: info.id },
    capabilities,
    request: (info.headers || request) && {
      headers: info.headers,
      body: request,
    },
    variants:
      info.variants &&
      Object.entries(info.variants).map(([id, options]) => ({
        id,
        body: lowerer.request(options),
      })),
    cost: costs,
    disabled: info.status === "deprecated" ? true : undefined,
    limit: info.limit && {
      context: int(info.limit.context),
      input: info.limit.input === undefined ? undefined : int(info.limit.input),
      output: int(info.limit.output),
    },
  }
}

function int(value: number) {
  return Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)))
}
