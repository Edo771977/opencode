import { describe, expect, beforeAll, afterAll } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { filesystem } from "@opencode-ai/core/effect/app-node-platform"
import { Global } from "@opencode-ai/core/global"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem, Layer } from "effect"
import { systemError } from "effect/PlatformError"
import { mkdir, rm, utimes, writeFile } from "fs/promises"
import path from "path"
import { Discovery } from "../../src/skill/discovery"
import { testEffect } from "../lib/effect"

// Windows refuses to rename a directory while anything still holds a handle inside it, which is how
// a skill refresh came to keep its cached copy on a hosted runner. That refusal cannot be provoked
// on the runners this suite runs on, so it is injected at the one call it reaches — `rename` — and
// built by the platform's own constructor rather than shaped by hand here. A real one, captured
// through `fs.rename` against a directory whose parent was made immutable, is `reason._tag:
// "Unknown"` carrying `reason.cause.code: "EPERM"`: @effect/platform-node-shared gives EACCES and
// EBUSY reasons of their own and leaves EPERM without one.
const eperm = (from: string) =>
  systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor: from,
    syscall: "rename",
    cause: Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: "EPERM" }),
  })

// Which renames the platform refuses, and how many were actually refused. Each test sets the first
// and reads the second: without that count a retry that never ran would look like one that did.
let refuse: (from: string) => boolean = () => false
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
        // re-run the same failed Effect and the count would stay at one however often it was tried.
        rename: (from: string, to: string) =>
          Effect.suspend(() => {
            if (!refuse(from)) return real.rename(from, to)
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
let content = "# One"

const cacheDir = path.join(Global.Path.cache, "skills")
const read = (dir: string) => Effect.promise(() => Bun.file(path.join(dir, "SKILL.md")).text())

// Publishes a version and pulls it with nothing refused, so each test starts from a cache it put
// there itself and can be run alone.
const publish = (next: string, text: string) =>
  Effect.gen(function* () {
    version = next
    content = text
    refuse = () => false
    refused = 0
    const dirs = yield* (yield* Discovery.Service).pull(url)
    expect(yield* read(dirs[0])).toBe(text)
  })

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

describe("Discovery.pull under a refused swap", () => {
  it.live(
    "retries a refusal that passes and lands the refreshed skill",
    () =>
      Effect.gen(function* () {
        yield* publish("1", "# One")

        version = "2"
        content = "# Two"
        let left = 2
        refuse = () => left-- > 0

        const dirs = yield* (yield* Discovery.Service).pull(url)

        expect(refused).toBe(2)
        expect(yield* read(dirs[0])).toBe("# Two")
      }),
    30_000,
  )

  it.live(
    "retries the refusal on moving the download in, and restores the cached copy when it does not pass",
    () =>
      Effect.gen(function* () {
        yield* publish("3", "# Three")

        version = "4"
        content = "# Four"
        // Only the second rename of the swap, `staging` -> `root`, which the first test never
        // reaches. It is also the only way into the rollback: with `root` already moved aside, a
        // refusal here is what has to put it back, and a swap that gave up without restoring would
        // lose the skill outright rather than leave it stale.
        refuse = (from) => from.includes(".tmp-")

        const dirs = yield* (yield* Discovery.Service).pull(url)

        expect(refused).toBeGreaterThan(10)
        expect(dirs.length).toBe(1)
        expect(yield* read(dirs[0])).toBe("# Three")
      }),
    60_000,
  )

  it.live(
    "gives the refusal up rather than spinning, and keeps the cached skill",
    () =>
      Effect.gen(function* () {
        yield* publish("5", "# Five")

        version = "6"
        content = "# Six"
        refuse = () => true

        const started = Date.now()
        const dirs = yield* (yield* Discovery.Service).pull(url)
        const elapsed = Date.now() - started

        // The bound is the point of this one: it has to stop on its own, and near three seconds
        // rather than whenever the test's own ceiling runs out.
        expect(elapsed).toBeLessThan(10_000)
        expect(refused).toBeGreaterThan(10)
        expect(yield* read(dirs[0])).toBe("# Five")

        refuse = () => false
      }),
    60_000,
  )

  it.live(
    "sweeps what a refused delete left behind, and keeps what a swap may still need",
    () =>
      Effect.gen(function* () {
        yield* publish("7", "# Seven")

        // The leak: a swap that landed and could not delete what it had moved aside. `held` is back
        // in place, so the copy under the backup's name answers to nothing.
        const abandoned = path.join(cacheDir, `held.old-${crypto.randomUUID()}`)
        // The same name shape, but its skill is not there. That is a swap whose rollback was refused
        // too: the backup is the only copy of the skill left on disk, and sweeping it loses the
        // skill outright — which is what the two tests above exist to prevent.
        const rollback = path.join(cacheDir, `gone.old-${crypto.randomUUID()}`)
        // A download still running, here or in another opencode sharing this cache.
        const inFlight = path.join(cacheDir, `held.tmp-${crypto.randomUUID()}`)
        // A download that died. Nothing pairs with it, so age is all there is to go on — and its
        // mtime is its own, because staging directories are made here rather than moved.
        const stalled = path.join(cacheDir, `held.tmp-${crypto.randomUUID()}`)
        const unrelated = path.join(cacheDir, "held.old-not-a-uuid")
        // A backup whose name is answered by a plain file rather than by the cached directory. The
        // rule is about a swap, and a swap only moves directories, so a file at `<name>` is not
        // `<name>` back in place — reading it as one sweeps a backup that is still the only copy.
        const shadowed = path.join(cacheDir, `pinned.old-${crypto.randomUUID()}`)
        const fileShaped = path.join(cacheDir, `held.old-${crypto.randomUUID()}`)
        yield* Effect.promise(async () => {
          for (const dir of [abandoned, rollback, inFlight, stalled, unrelated, shadowed]) {
            await mkdir(dir, { recursive: true })
            await writeFile(path.join(dir, "SKILL.md"), "# Leftover")
          }
          await writeFile(path.join(cacheDir, "pinned"), "not a directory")
          // Right shape, wrong kind: the swap never leaves a file behind, so this is somebody else's
          // and not ours to delete.
          await writeFile(fileShaped, "not a directory either")
          const hour = new Date(Date.now() - 2 * 60 * 60 * 1000)
          await utimes(stalled, hour, hour)
          // Backdated on the three that must survive as well, so nothing here passes by being new.
          await utimes(rollback, hour, hour)
          await utimes(unrelated, hour, hour)
          await utimes(shadowed, hour, hour)
        })

        version = "8"
        content = "# Eight"
        const dirs = yield* (yield* Discovery.Service).pull(url)

        expect(yield* read(dirs[0])).toBe("# Eight")
        const left = (dir: string) => Effect.promise(() => Bun.file(path.join(dir, "SKILL.md")).exists())
        expect(yield* left(abandoned)).toBe(false)
        expect(yield* left(stalled)).toBe(false)
        expect(yield* left(rollback)).toBe(true)
        expect(yield* left(inFlight)).toBe(true)
        // Swept by the shape the swap produces, not by anything that happens to sit beside a skill.
        expect(yield* left(unrelated)).toBe(true)
        expect(yield* left(shadowed)).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(fileShaped).exists())).toBe(true)

        yield* Effect.promise(() =>
          Promise.all(
            [rollback, inFlight, unrelated, shadowed, fileShaped, path.join(cacheDir, "pinned")].map((entry) =>
              rm(entry, { recursive: true, force: true }),
            ),
          ),
        )
      }),
    60_000,
  )
})
