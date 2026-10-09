import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient, path } from "@opencode-ai/core/effect/app-node-platform"
import { NodePath } from "@effect/platform-node"
import { Effect, Layer, Path, Schema, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SkillIndexEntry } from "@opencode-ai/core/skill/index-entry"
import { Global } from "@opencode-ai/core/global"

const skillConcurrency = 4
const fileConcurrency = 8

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

    // Whether an index entry may be turned into paths, and which ones. Every value here came out of
    // a document fetched over the network, and nothing downstream questions it: `path.join` resolves
    // a `..` without complaint and `writeWithDirs` creates whatever directories it needs on the way,
    // so an entry named `..` writes outside the skills cache and a file of `../x` outside its own
    // skill. Checked before anything is fetched, and a skill with one bad file is refused whole
    // rather than left half written. Returns the reason when it refuses, because a refusal nobody
    // can see is how this lived as long as it did (#38). The V2 runtime has checked the same two
    // things since it was written, which is why the checks themselves are shared.
    const checkEntry = (skill: IndexSkill, base: string) => {
      if (!SkillIndexEntry.isSafeSegment(skill.name)) return "its name is not a single directory"
      const root = path.join(cache, skill.name)
      if (!FSUtil.contains(cache, root) || root === cache) return "its name does not stay inside the cache"

      // The three checks below — this one, the origin, and the destination staying under the skill —
      // are belt: given the two validators no reachable name or file gets past them, and no test
      // covers them for that reason. They are here because they are the cheap half of the pair, and
      // because the V2 runtime carries the same ones.
      const source = new URL(base)
      const skillUrl = new URL(`${encodeURIComponent(skill.name)}/`, base)
      const files = skill.files.map((file) => {
        if (!SkillIndexEntry.isSafeRelativePath(file)) return undefined
        if (!URL.canParse(file, skillUrl)) return undefined
        const resource = new URL(file, skillUrl)
        if (resource.origin !== source.origin) return undefined
        // Against `root`, and that covers staging too: staging is `root` with a suffix, so a path
        // contained by one is contained by the other.
        const destination = path.join(root, file)
        if (!FSUtil.contains(root, destination) || destination === root) return undefined
        return { file, url: resource.href }
      })
      if (files.some((file) => file === undefined)) return "one of its files is not a path inside the skill"
      return { root, files: files as { file: string; url: string }[] }
    }

    const pull = Effect.fn("Discovery.pull")(function* (url: string) {
      const base = url.endsWith("/") ? url : `${url}/`
      const index = new URL("index.json", base).href

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
      const checked = data.skills
        .filter((skill) => skill.files.includes("SKILL.md"))
        .map((skill) => ({ skill, checked: checkEntry(skill, base) }))
      yield* Effect.forEach(
        checked.filter((entry) => typeof entry.checked === "string"),
        (entry) =>
          Effect.logWarning("refusing skill entry", { url: index, skill: entry.skill.name, reason: entry.checked }),
        { discard: true },
      )
      const list = checked.flatMap((entry) =>
        typeof entry.checked === "string" ? [] : [{ skill: entry.skill, ...entry.checked }],
      )

      yield* FSUtil.sweepStale(fs, cache)

      const dirs = yield* Effect.forEach(
        list,
        ({ skill, root, files }) =>
          Effect.gen(function* () {
            const versionFile = path.join(root, ".opencode-version")
            const version = skill.version
            const current =
              version === undefined
                ? undefined
                : yield* fs.readFileStringSafe(versionFile).pipe(Effect.catch(() => Effect.succeed(undefined)))

            if (version === undefined || current === version) {
              yield* Effect.forEach(files, (file) => download(file.url, path.join(root, file.file)), {
                concurrency: fileConcurrency,
                discard: true,
              })
            } else {
              const { staging, backup } = FSUtil.stagingNames(root)
              yield* Effect.gen(function* () {
                const downloaded = yield* Effect.forEach(
                  files,
                  (file) => download(file.url, path.join(staging, file.file)),
                  { concurrency: fileConcurrency },
                )
                if (!downloaded.every(Boolean)) return
                yield* fs.writeFileString(path.join(staging, ".opencode-version"), version)
                // Every file the index named, not just `SKILL.md`: the swap deletes the backup, so
                // it has to refuse a staging directory that has lost files since it was filled
                // rather than promote a partial copy. Entries without `SKILL.md` are already
                // dropped upstream, so that check is this one's first element.
                yield* FSUtil.swapStaged(
                  fs,
                  root,
                  staging,
                  backup,
                  files.map((file) => file.file),
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
