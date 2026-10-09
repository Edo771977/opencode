export * as SkillDiscovery from "./discovery"

import path from "path"
import { Context, Effect, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { FSUtil } from "../fs-util"
import { SkillIndexEntry } from "./index-entry"
import { Global } from "../global"
import { makeGlobalNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { AbsolutePath } from "../schema"

const skillConcurrency = 4
const fileConcurrency = 8

class IndexSkill extends Schema.Class<IndexSkill>("SkillDiscovery.IndexSkill")({
  name: Schema.String,
  version: Schema.optional(Schema.String),
  files: Schema.Array(Schema.String),
}) {}

class Index extends Schema.Class<Index>("SkillDiscovery.Index")({
  skills: Schema.Array(IndexSkill),
}) {}

export interface Interface {
  readonly pull: (url: string) => Effect.Effect<AbsolutePath[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SkillDiscovery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.retryTransient({
        retryOn: "errors-and-responses",
        times: 2,
        schedule: Schedule.exponential(200).pipe(Schedule.jittered),
      }),
      HttpClient.filterStatusOk,
    )

    const download = Effect.fn("SkillDiscovery.download")(function* (url: string, destination: string) {
      if (yield* fs.exists(destination).pipe(Effect.orDie)) return true
      return yield* HttpClientRequest.get(url).pipe(
        http.execute,
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.flatMap((body) => fs.writeWithDirs(destination, new Uint8Array(body))),
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logError("failed to download skill file", { url, error }).pipe(Effect.as(false)),
        ),
      )
    })

    return Service.of({
      pull: Effect.fn("SkillDiscovery.pull")(function* (url) {
        const base = url.endsWith("/") ? url : `${url}/`
        const source = new URL(base)
        const index = new URL("index.json", source).href
        const data = yield* HttpClientRequest.get(index).pipe(
          HttpClientRequest.acceptJson,
          http.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Index)),
          Effect.catch((error) =>
            Effect.logError("failed to fetch skill index", { url: index, error }).pipe(Effect.as(undefined)),
          ),
        )
        if (!data) return []

        const sourceRoot = path.resolve(global.cache, "skills", Bun.hash(base).toString(16))
        yield* FSUtil.sweepStale(fs, sourceRoot)

        return yield* Effect.forEach(
          data.skills.flatMap((skill) => {
            if (!SkillIndexEntry.isSafeSegment(skill.name)) {
              return []
            }
            if (!skill.files.includes("SKILL.md") && !skill.files.includes(`${skill.name}.md`)) {
              return []
            }

            const root = path.resolve(sourceRoot, skill.name)
            if (!FSUtil.contains(sourceRoot, root) || root === sourceRoot) {
              return []
            }

            const skillUrl = new URL(`${encodeURIComponent(skill.name)}/`, source)
            const versionFile = path.join(root, ".opencode-version")
            const files = skill.files.map((file) => {
              if (!SkillIndexEntry.isSafeRelativePath(file)) return undefined
              let resource: URL
              try {
                resource = new URL(file, skillUrl)
              } catch {
                return undefined
              }
              if (resource.origin !== source.origin) return undefined

              const destination = path.resolve(root, file)
              if (!FSUtil.contains(root, destination) || destination === root) return undefined
              return {
                url: resource.href,
                destination,
                file,
              }
            })
            if (files.some((file) => file === undefined)) {
              return []
            }
            return [{ skill, root, versionFile, files: files as { url: string; destination: string; file: string }[] }]
          }),
          ({ skill, root, versionFile, files }) =>
            Effect.gen(function* () {
              const version = skill.version
              const current =
                version === undefined
                  ? undefined
                  : yield* fs.readFileStringSafe(versionFile).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (version === undefined || current === version) {
                yield* Effect.forEach(files, (file) => download(file.url, file.destination), {
                  concurrency: fileConcurrency,
                  discard: true,
                })
              } else {
                const { staging, backup } = FSUtil.stagingNames(root)
                yield* Effect.gen(function* () {
                  const downloaded = yield* Effect.forEach(
                    files,
                    (file) => download(file.url, path.resolve(staging, file.file)),
                    { concurrency: fileConcurrency },
                  )
                  if (!downloaded.every(Boolean)) return
                  yield* fs.writeFileString(path.join(staging, ".opencode-version"), version)
                  // Every file the index named, not just the one that makes the directory a skill:
                  // the swap deletes the backup, so it has to refuse a staging directory that has
                  // lost files since it was filled rather than promote a partial copy. The entries
                  // reaching here are already filtered to name `SKILL.md` or `<name>.md`, so that
                  // check is this one's first element.
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
              const exists =
                (yield* fs.exists(path.join(root, "SKILL.md")).pipe(Effect.orDie)) ||
                (yield* fs.exists(path.join(root, `${skill.name}.md`)).pipe(Effect.orDie))
              return exists ? [AbsolutePath.make(root)] : []
            }),
          { concurrency: skillConcurrency },
        ).pipe(Effect.map((directories) => directories.flat()))
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [httpClient, FSUtil.node, Global.node] })
