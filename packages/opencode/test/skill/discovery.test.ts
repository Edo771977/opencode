import { describe, expect, beforeAll, afterAll } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { Discovery } from "../../src/skill/discovery"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { rm } from "fs/promises"
import path from "path"
import { testEffect } from "../lib/effect"

let CLOUDFLARE_SKILLS_URL: string
let server: ReturnType<typeof Bun.serve>
let downloadCount = 0
let mutableVersion = "1"
let mutableContent = "# Old"
let mutableDownloadCount = 0
let mutableFiles = ["SKILL.md"]
let hostile = false

const fixturePath = path.join(import.meta.dir, "../fixture/skills")
const cacheDir = path.join(Global.Path.cache, "skills")
const it = testEffect(LayerNode.compile(LayerNode.group([Discovery.node, FSUtil.node])))

beforeAll(async () => {
  await rm(cacheDir, { recursive: true, force: true })

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === "/mutable/index.json") {
        return Response.json({ skills: [{ name: "mutable", version: mutableVersion, files: mutableFiles }] })
      }
      if (url.pathname === "/mutable/mutable/SKILL.md") {
        mutableDownloadCount++
        return new Response(mutableContent)
      }
      if (url.pathname === "/mutable/mutable/old.md") return new Response("old reference")

      // An index that names paths of its own choosing, for #38. Every one of these is a path the
      // runtime would otherwise join onto the cache directory.
      if (url.pathname === "/hostile/index.json") {
        return Response.json({
          skills: [
            { name: "escape", files: ["SKILL.md", "../escaped.md"] },
            { name: "..", files: ["SKILL.md"] },
            { name: "nested/deep", files: ["SKILL.md"] },
            { name: "absolute", files: ["SKILL.md", "/etc/escaped-absolute.md"] },
            { name: "encoded", files: ["SKILL.md", "%2e%2e/escaped-encoded.md"] },
            { name: "honest", files: ["SKILL.md"] },
          ],
        })
      }

      // route /.well-known/skills/* to the fixture directory
      if (url.pathname.startsWith("/.well-known/skills/")) {
        const filePath = url.pathname.replace("/.well-known/skills/", "")
        const fullPath = path.join(fixturePath, filePath)

        if (await Filesystem.exists(fullPath)) {
          if (!fullPath.endsWith("index.json")) {
            downloadCount++
          }
          return new Response(Bun.file(fullPath))
        }
      }

      // A hostile index is only interesting if its server answers the paths it invented — including
      // the ones that resolved off its own directory, which is what a real one would do.
      if (hostile && url.pathname.endsWith(".md")) return new Response("# Hostile")

      return new Response("Not Found", { status: 404 })
    },
  })

  CLOUDFLARE_SKILLS_URL = `http://localhost:${server.port}/.well-known/skills/`
})

afterAll(async () => {
  void server?.stop()
  await rm(cacheDir, { recursive: true, force: true })
})

describe("Discovery.pull", () => {
  it.live("downloads skills from cloudflare url", () =>
    Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      const discovery = yield* Discovery.Service
      const dirs = yield* discovery.pull(CLOUDFLARE_SKILLS_URL)
      expect(dirs.length).toBeGreaterThan(0)
      for (const dir of dirs) {
        expect(dir).toStartWith(cacheDir)
        const md = path.join(dir, "SKILL.md")
        expect(yield* fsys.existsSafe(md)).toBe(true)
      }
    }),
  )

  it.live("url without trailing slash works", () =>
    Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      const discovery = yield* Discovery.Service
      const dirs = yield* discovery.pull(CLOUDFLARE_SKILLS_URL.replace(/\/$/, ""))
      expect(dirs.length).toBeGreaterThan(0)
      for (const dir of dirs) {
        const md = path.join(dir, "SKILL.md")
        expect(yield* fsys.existsSafe(md)).toBe(true)
      }
    }),
  )

  it.live("returns empty array for invalid url", () =>
    Effect.gen(function* () {
      const discovery = yield* Discovery.Service
      const dirs = yield* discovery.pull(`http://localhost:${server.port}/invalid-url/`)
      expect(dirs).toEqual([])
    }),
  )

  it.live("returns empty array for non-json response", () =>
    Effect.gen(function* () {
      // any url not explicitly handled in server returns 404 text "Not Found"
      const discovery = yield* Discovery.Service
      const dirs = yield* discovery.pull(`http://localhost:${server.port}/some-other-path/`)
      expect(dirs).toEqual([])
    }),
  )

  it.live("downloads reference files alongside SKILL.md", () =>
    Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      const discovery = yield* Discovery.Service
      const dirs = yield* discovery.pull(CLOUDFLARE_SKILLS_URL)
      // find a skill dir that should have reference files (e.g. agents-sdk)
      const agentsSdk = dirs.find((d) => d.endsWith(path.sep + "agents-sdk"))
      expect(agentsSdk).toBeDefined()
      if (agentsSdk) {
        const refs = path.join(agentsSdk, "references")
        expect(yield* fsys.existsSafe(path.join(agentsSdk, "SKILL.md"))).toBe(true)
        // agents-sdk has reference files per the index
        const refDir = yield* Effect.promise(() =>
          Array.fromAsync(new Bun.Glob("**/*.md").scan({ cwd: refs, onlyFiles: true })),
        )
        expect(refDir.length).toBeGreaterThan(0)
      }
    }),
  )

  it.live("caches downloaded files on second pull", () =>
    Effect.gen(function* () {
      // clear dir and downloadCount
      yield* Effect.promise(() => rm(cacheDir, { recursive: true, force: true }))
      downloadCount = 0
      const discovery = yield* Discovery.Service

      // first pull to populate cache
      const first = yield* discovery.pull(CLOUDFLARE_SKILLS_URL)
      expect(first.length).toBeGreaterThan(0)
      const firstCount = downloadCount
      expect(firstCount).toBeGreaterThan(0)

      // second pull should return same results from cache
      const second = yield* discovery.pull(CLOUDFLARE_SKILLS_URL)
      expect(second.length).toBe(first.length)
      expect(second.sort()).toEqual(first.sort())

      // second pull should NOT increment download count
      expect(downloadCount).toBe(firstCount)
    }),
  )

  it.live("refreshes a remote skill when its version changes", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => rm(cacheDir, { recursive: true, force: true }))
      mutableVersion = "1"
      mutableContent = "# Old"
      mutableDownloadCount = 0
      mutableFiles = ["SKILL.md", "old.md"]
      const discovery = yield* Discovery.Service
      const url = `http://localhost:${server.port}/mutable/`

      const first = yield* discovery.pull(url)
      expect(yield* Effect.promise(() => Bun.file(path.join(first[0], "SKILL.md")).text())).toBe("# Old")

      mutableVersion = "2"
      mutableContent = "# Partial"
      mutableFiles = ["SKILL.md", "missing.md"]
      const second = yield* discovery.pull(url)
      expect(yield* Effect.promise(() => Bun.file(path.join(second[0], "SKILL.md")).text())).toBe("# Old")
      expect(yield* Effect.promise(() => Bun.file(path.join(second[0], "old.md")).text())).toBe("old reference")

      mutableVersion = "3"
      mutableContent = "# New"
      mutableFiles = ["SKILL.md"]
      yield* discovery.pull(url)
      expect(yield* Effect.promise(() => Bun.file(path.join(second[0], "SKILL.md")).text())).toBe("# New")
      expect(yield* Effect.promise(() => Bun.file(path.join(second[0], "old.md")).exists())).toBe(false)
      expect(mutableDownloadCount).toBe(3)

      yield* discovery.pull(url)
      expect(mutableDownloadCount).toBe(3)
    }),
  )

  // #38: every path here comes out of a document fetched over the network. `path.join` resolves a
  // `..` without complaint and `writeWithDirs` creates whatever it needs on the way, so an index
  // that names `../escaped.md` writes outside the skill it belongs to, and one whose `name` is `..`
  // writes outside the skills cache entirely. The V2 runtime has checked both since it was written.
  it.live("refuses the paths an index makes up, and keeps the honest one", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => rm(cacheDir, { recursive: true, force: true }))
      const discovery = yield* Discovery.Service
      hostile = true
      const dirs = yield* Effect.ensuring(
        discovery.pull(`http://localhost:${server.port}/hostile/`),
        Effect.sync(() => {
          hostile = false
        }),
      )

      // Only the well-formed entry survives, and it is a directory of the cache, not below it.
      expect(dirs).toEqual([path.join(cacheDir, "honest")])

      const gone = (file: string) => Effect.promise(() => Bun.file(file).exists())
      // Out of the skill, still inside the cache.
      expect(yield* gone(path.join(cacheDir, "escaped.md"))).toBe(false)
      // Out of the cache: `name` as `..` makes the skill's root the cache's own parent.
      expect(yield* gone(path.join(Global.Path.cache, "SKILL.md"))).toBe(false)
      // `%2e%2e` is `..` by the time the server resolves it: the write stays under the skill, the
      // fetch does not, which is why the check decodes each segment.
      expect(yield* gone(path.join(cacheDir, "encoded", "%2e%2e", "escaped-encoded.md"))).toBe(false)
      // A name with a separator in it is not one directory.
      expect(yield* gone(path.join(cacheDir, "nested", "deep", "SKILL.md"))).toBe(false)
      // An absolute file path is not relative to anything — `path.join` would keep it under the
      // skill, but the URL it builds is the one an index should not get to choose.
      expect(yield* gone(path.join(cacheDir, "absolute", "etc", "escaped-absolute.md"))).toBe(false)
      // A rejected entry takes its whole skill with it rather than landing half-written.
      for (const name of ["escape", "absolute", "encoded", "nested"]) {
        expect(yield* gone(path.join(cacheDir, name, "SKILL.md"))).toBe(false)
      }
    }),
  )
})
