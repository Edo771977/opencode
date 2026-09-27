import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient, path } from "@opencode-ai/core/effect/app-node-platform"
import { NodePath } from "@effect/platform-node"
import { Effect, Layer, Path, Schedule, Schema, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"

const skillConcurrency = 4
const fileConcurrency = 8

// Windows refuses to rename a directory while anything still holds a handle inside it, and
// the refusal passes: whatever was reading, or the scanner that followed it in, lets go in a
// moment. Seen as EPERM renaming a cached skill out of the way on a hosted Windows runner,
// where it cost the refresh — the downloaded version was discarded and the stale one kept,
// with only a log line to say so.
const renameRetry = Schedule.exponential(25, 1.7).pipe(
  Schedule.either(Schedule.spaced(250)),
  Schedule.jittered,
  Schedule.while((meta) => meta.elapsed < 3_000),
)

class IndexSkill extends Schema.Class<IndexSkill>("IndexSkill")({
  name: Schema.String,
  files: Schema.Array(Schema.String),
  version: Schema.optional(Schema.String),
}) {}

class Index extends Schema.Class<Index>("Index")({
  skills: Schema.Array(IndexSkill),
}) {}

export interface Interface {
  readonly pull: (url: string) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillDiscovery") {}

const layer: Layer.Layer<Service, never, FSUtil.Service | Path.Path | HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const path = yield* Path.Path
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const cache = path.join(Global.Path.cache, "skills")

    const download = Effect.fn("Discovery.download")(function* (url: string, dest: string) {
      if (yield* fs.exists(dest).pipe(Effect.orDie)) return true

      return yield* HttpClientRequest.get(url).pipe(
        http.execute,
        Effect.flatMap((res) => res.arrayBuffer),
        Effect.flatMap((body) => fs.writeWithDirs(dest, new Uint8Array(body))),
        Effect.as(true),
        Effect.catch((err) => Effect.logError("failed to download", { url: url, error: err }).pipe(Effect.as(false))),
      )
    })

    // Retried on the codes that mean the directory is held rather than unwritable. EPERM has no
    // reason of its own — @effect/platform-node-shared maps EACCES to PermissionDenied and EBUSY
    // to Busy and leaves everything else Unknown — so the cause is what tells it apart, and
    // catching Unknown alone would retry failures that are not going to pass.
    const swap = (from: string, to: string) =>
      fs.rename(from, to).pipe(
        Effect.retry({
          while: (error) =>
            error.reason._tag === "Busy" ||
            error.reason._tag === "PermissionDenied" ||
            (error.reason._tag === "Unknown" &&
              typeof error.reason.cause === "object" &&
              error.reason.cause !== null &&
              "code" in error.reason.cause &&
              error.reason.cause.code === "EPERM"),
          schedule: renameRetry,
        }),
      )

    const pull = Effect.fn("Discovery.pull")(function* (url: string) {
      const base = url.endsWith("/") ? url : `${url}/`
      const index = new URL("index.json", base).href
      const host = base.slice(0, -1)

      yield* Effect.logInfo("fetching index", { url: index })

      const data = yield* HttpClientRequest.get(index).pipe(
        HttpClientRequest.acceptJson,
        http.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Index)),
        Effect.catch((err) =>
          Effect.logError("failed to fetch index", { url: index, error: err }).pipe(Effect.as(null)),
        ),
      )

      if (!data) return []

      const missing = data.skills.filter((skill) => !skill.files.includes("SKILL.md"))
      yield* Effect.forEach(
        missing,
        (skill) => Effect.logWarning("skill entry missing SKILL.md", { url: index, skill: skill.name }),
        { discard: true },
      )
      const list = data.skills.filter((skill) => skill.files.includes("SKILL.md"))

      const dirs = yield* Effect.forEach(
        list,
        (skill) =>
          Effect.gen(function* () {
            const root = path.join(cache, skill.name)
            const versionFile = path.join(root, ".opencode-version")
            const version = skill.version
            const current =
              version === undefined
                ? undefined
                : yield* fs.readFileStringSafe(versionFile).pipe(Effect.catch(() => Effect.succeed(undefined)))

            if (version === undefined || current === version) {
              yield* Effect.forEach(
                skill.files,
                (file) => download(new URL(file, `${host}/${skill.name}/`).href, path.join(root, file)),
                { concurrency: fileConcurrency, discard: true },
              )
            } else {
              const token = crypto.randomUUID()
              const staging = `${root}.tmp-${token}`
              const backup = `${root}.old-${token}`
              yield* Effect.gen(function* () {
                const downloaded = yield* Effect.forEach(
                  skill.files,
                  (file) => download(new URL(file, `${host}/${skill.name}/`).href, path.join(staging, file)),
                  { concurrency: fileConcurrency },
                )
                if (!downloaded.every(Boolean)) return
                if (!(yield* fs.exists(path.join(staging, "SKILL.md")).pipe(Effect.orDie))) return
                yield* fs.writeFileString(path.join(staging, ".opencode-version"), version)
                yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    const cached = yield* fs.exists(root).pipe(Effect.orDie)
                    if (cached) yield* swap(root, backup)
                    yield* swap(staging, root).pipe(
                      Effect.catch((error) =>
                        Effect.gen(function* () {
                          if (cached) yield* fs.rename(backup, root).pipe(Effect.ignore)
                          return yield* Effect.fail(error)
                        }),
                      ),
                    )
                    if (cached) yield* fs.remove(backup, { recursive: true, force: true }).pipe(Effect.ignore)
                  }),
                )
              }).pipe(
                Effect.catch((error) => Effect.logError("failed to refresh skill", { skill: skill.name, error })),
                Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
              )
            }
            return (yield* fs.exists(path.join(root, "SKILL.md")).pipe(Effect.orDie)) ? root : null
          }),
        { concurrency: skillConcurrency },
      )

      return dirs.filter((dir): dir is string => dir !== null)
    })

    return Service.of({ pull })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node, path, httpClient] })

export * as Discovery from "./discovery"
