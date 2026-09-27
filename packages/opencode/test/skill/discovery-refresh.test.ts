import { expect, beforeAll, afterAll } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { filesystem } from "@opencode-ai/core/effect/app-node-platform"
import { Global } from "@opencode-ai/core/global"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem, Layer } from "effect"
import * as PlatformError from "effect/PlatformError"
import { rm } from "fs/promises"
import path from "path"
import { Discovery } from "../../src/skill/discovery"
import { testEffect } from "../lib/effect"

// Windows refuses to rename a directory while anything still holds a handle inside it, which is
// how a skill refresh came to keep its cached copy on a hosted runner. The refusal cannot be
// produced on the runners this suite runs on, so it is injected at the one call it reaches —
// `rename` — and built by the same constructor the platform uses, rather than hand-shaped here.
// A real one, captured through `fs.rename` against a directory whose parent was made immutable,
// is `reason._tag: "Unknown"` carrying `reason.cause.code: "EPERM"`: EACCES and EBUSY are given
// reasons of their own by @effect/platform-node-shared and EPERM is not.
const eperm = (from: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor: from,
    syscall: "rename",
    cause: Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: "EPERM" }),
  })

let refusalsLeft = 0
let refused = 0

const refusingFilesystem = makeGlobalNode({
  service: FileSystem.FileSystem,
  layer: Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem
      return {
        ...real,
        // Suspended so the decision is taken on every execution: built eagerly, a retry would
        // re-run the same failed Effect and the count below would see one refusal however many
        // times it was tried.
        rename: (from: string, to: string) =>
          Effect.suspend(() => {
            if (refusalsLeft <= 0) return real.rename(from, to)
            refusalsLeft--
            refused++
            return Effect.fail(eperm(from))
          }),
      }
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer)),
  deps: [],
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Discovery.node, FSUtil.node]), [[filesystem, refusingFilesystem]]),
)

let url: string
let server: ReturnType<typeof Bun.serve>
let version = "1"
let content = "# Old"

const cacheDir = path.join(Global.Path.cache, "skills")
const read = (dir: string) => Effect.promise(() => Bun.file(path.join(dir, "SKILL.md")).text())

beforeAll(async () => {
  await rm(cacheDir, { recursive: true, force: true })
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const pathname = new URL(req.url).pathname
      if (pathname === "/index.json") return Response.json({ skills: [{ name: "held", version, files: ["SKILL.md"] }] })
      if (pathname === "/held/SKILL.md") return new Response(content)
      return new Response("Not Found", { status: 404 })
    },
  })
  url = `http://localhost:${server.port}/`
})

afterAll(() => {
  void server?.stop(true)
})

it.live(
  "retries a refused swap and lands the refreshed skill",
  () =>
    Effect.gen(function* () {
      const discovery = yield* Discovery.Service

      const first = yield* discovery.pull(url)
      expect(yield* read(first[0])).toBe("# Old")

      version = "2"
      content = "# New"
      refused = 0
      refusalsLeft = 2

      const second = yield* discovery.pull(url)

      // Both halves of the assertion matter: that the refusal was actually delivered, and that the
      // refresh survived it. Without the first, a retry that never ran would look the same.
      expect(refused).toBe(2)
      expect(refusalsLeft).toBe(0)
      expect(yield* read(second[0])).toBe("# New")
    }),
  30_000,
)

it.live(
  "keeps the cached skill when the swap is refused for good",
  () =>
    Effect.gen(function* () {
      const discovery = yield* Discovery.Service

      version = "3"
      content = "# Newer"
      refused = 0
      refusalsLeft = Number.POSITIVE_INFINITY

      const dirs = yield* discovery.pull(url)

      // The retry gives up rather than hanging, and an unrefreshed skill stays usable at the
      // version it already had: a stale skill is worth more here than none.
      expect(refused).toBeGreaterThan(1)
      expect(yield* read(dirs[0])).toBe("# New")

      refusalsLeft = 0
    }),
  60_000,
)
