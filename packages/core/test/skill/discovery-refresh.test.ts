import { describe, expect, beforeAll, afterAll } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { SkillDiscovery } from "@opencode/core/skill/discovery"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { filesystem } from "@opencode/util/effect/app-node-platform"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Hash } from "@opencode/util/hash"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem, Layer } from "effect"
import { systemError } from "effect/PlatformError"
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "fs/promises"
import os from "os"
import path from "path"
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

const refusingFilesystem = filesystem.replace(
  Layer.effect(
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
)

// A cache of the suite's own, made before the layer is built because the layer reads it.
const cache = await mkdtemp(path.join(os.tmpdir(), "opencode-skill-refresh-"))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillDiscovery.node, FSUtil.node]), [
    Global.node.replace(Global.layerWith({ cache })),
    refusingFilesystem,
  ]),
)

let url: string
let server: ReturnType<typeof Bun.serve>
let version = "1"
let content = "# One"
// A second file, so a download can lose one and still answer a `SKILL.md` check. The last test
// sets these; everything above it publishes the single file the rest of the suite expects.
let files = ["SKILL.md"]
let reference = "# Reference one"
// Holds the response for `SKILL.md` open, which is how the last test gets a staging directory with
// the other file already written and this one still in flight, without racing it.
let hold: Promise<void> | undefined

// Each source keeps its skills under a directory named for its URL, so that — not `skills` above
// it — is where the swaps leave their copies. Set once the server has a port.
let cacheDir: string
const read = (dir: string) => Effect.promise(() => Bun.file(path.join(dir, "SKILL.md")).text())

// Publishes a version and pulls it with nothing refused, so each test starts from a cache it put
// there itself and can be run alone.
const publish = (next: string, text: string) =>
  Effect.gen(function* () {
    version = next
    content = text
    refuse = () => false
    refused = 0
    const discovery = yield* SkillDiscovery.Service
    const dirs = yield* discovery.pull(url)
    expect(yield* read(dirs[0])).toBe(text)
  })

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const pathname = new URL(req.url).pathname
      if (pathname === "/index.json") return Response.json({ skills: [{ name: "held", version, files }] })
      if (pathname === "/held/SKILL.md") {
        if (hold) await hold
        return new Response(content)
      }
      if (pathname === "/held/reference.md") return new Response(reference)
      return new Response("Not Found", { status: 404 })
    },
  })
  url = `http://127.0.0.1:${server.port}/`
  cacheDir = path.join(cache, "skills", Hash.fast(url))
})

afterAll(async () => {
  void server?.stop(true)
  await rm(cache, { recursive: true, force: true })
})

describe("SkillDiscovery.pull under a refused swap", () => {
  it.live(
    "retries a refusal that passes and lands the refreshed skill",
    () =>
      Effect.gen(function* () {
        const discovery = yield* SkillDiscovery.Service
        yield* publish("1", "# One")

        version = "2"
        content = "# Two"
        let left = 2
        refuse = () => left-- > 0

        const dirs = yield* discovery.pull(url)

        expect(refused).toBe(2)
        expect(yield* read(dirs[0])).toBe("# Two")
      }),
    30_000,
  )

  it.live(
    "retries the refusal on moving the download in, and restores the cached copy when it does not pass",
    () =>
      Effect.gen(function* () {
        const discovery = yield* SkillDiscovery.Service
        yield* publish("3", "# Three")

        version = "4"
        content = "# Four"
        // Only the second rename of the swap, `staging` -> `root`, which the first test never
        // reaches. It is also the only way into the rollback: with `root` already moved aside, a
        // refusal here is what has to put it back, and a swap that gave up without restoring would
        // lose the skill outright rather than leave it stale.
        refuse = (from) => from.includes(".tmp-")

        const dirs = yield* discovery.pull(url)

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
        const discovery = yield* SkillDiscovery.Service
        yield* publish("5", "# Five")

        version = "6"
        content = "# Six"
        refuse = () => true

        const started = Date.now()
        const dirs = yield* discovery.pull(url)
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
        const discovery = yield* SkillDiscovery.Service
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
        const dirs = yield* discovery.pull(url)

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

  // The two halves of #39 meeting: a staging directory that stalled past `STAGING_MAX_AGE_MS` is
  // collectable from any process sharing this cache, `writeWithDirs` makes it again for whichever
  // files were still to be written, and promoting what is left deletes the backup. The cached skill
  // is then replaced by a partial copy of itself with nothing logged — the only path through this
  // that loses content rather than a refresh, and the reason the swap now refuses a download that
  // is missing a file instead of checking that `SKILL.md` happens to be there.
  it.live(
    "refuses a download a sweep took a file from, and keeps the cached skill whole",
    () =>
      Effect.gen(function* () {
        const discovery = yield* SkillDiscovery.Service
        files = ["SKILL.md", "reference.md"]
        yield* publish("9", "# Nine")
        const root = path.join(cacheDir, "held")
        const second = () => Effect.promise(() => Bun.file(path.join(root, "reference.md")).text())
        expect(yield* second()).toBe("# Reference one")

        version = "10"
        content = "# Ten"
        reference = "# Reference ten"
        let release = () => {}
        hold = new Promise<void>((resolve) => {
          release = resolve
        })

        // The sweep's side of it, by hand: provoking the real one wants a staging directory an hour
        // old, and what it does to a live download is take a file it has already written. The
        // response for `SKILL.md` stays open until that has happened, so the swap is reached with a
        // staging directory holding only the file that landed after the sweep.
        const taken = Effect.promise(async () => {
          const deadline = Date.now() + 20_000
          while (Date.now() < deadline) {
            const staging = (await readdir(cacheDir)).find((entry) => entry.startsWith("held.tmp-"))
            const file = staging === undefined ? undefined : path.join(cacheDir, staging, "reference.md")
            if (file !== undefined && (await Bun.file(file).exists())) {
              await rm(file)
              release()
              return true
            }
            await Bun.sleep(25)
          }
          release()
          return false
        })

        const [removed, dirs] = yield* Effect.all([taken, discovery.pull(url)], {
          concurrency: "unbounded",
        }).pipe(Effect.ensuring(Effect.sync(() => (hold = undefined))))

        // Without this the rest proves nothing: a pull that finished before the file was taken
        // would leave the cache correct for the wrong reason.
        expect(removed).toBe(true)
        expect(yield* read(dirs[0])).toBe("# Nine")
        // The half a `SKILL.md` check cannot see, and the one that was lost for good: a promotion
        // deletes the backup, so this file had no other copy on disk.
        expect(yield* second()).toBe("# Reference one")

        // And the refusal left the refresh retryable rather than wedged: a promotion would have
        // written "10" beside the partial copy, and every later pull would have had nothing to do.
        const again = yield* discovery.pull(url)
        expect(yield* read(again[0])).toBe("# Ten")
        expect(yield* second()).toBe("# Reference ten")
      }).pipe(Effect.ensuring(Effect.sync(() => (files = ["SKILL.md"])))),
    60_000,
  )
})
