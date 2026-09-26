import { afterEach, expect } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Cause, Effect, Exit, Fiber } from "effect"
import { bootstrap as cliBootstrap } from "../../src/cli/bootstrap"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { waitGlobalBusEvent } from "../server/global-bus"

const it = testEffect(
  LayerNode.compile(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node]), [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
  ]),
)

// InstanceBootstrap must run before any code touches the instance —
// originally tracked by PRs #25389 and #25449, now a permanent
// invariant. The plugin config hook writes a marker file; the test
// bodies deliberately avoid Plugin/config directly. The marker only
// appears if InstanceBootstrap ran at the instance boundary.
//
// The boundaries below are transport-agnostic and stay.
//
// All four carry the same ceiling because the cost follows execution order rather
// than a particular test: whichever runs first pays this process's first real
// InstanceBootstrap, whose global nodes are then memoized for every instance after
// it. Measured on Linux, that is 12-17s for the first test and about 0.4s for each
// one after, which is how the first crossed the suite-wide 30s on a Windows runner
// two and a half times slower (#20). Pinning the ceiling to whichever test happens
// to be written first would break under a reorder, a `-t` filter or a `.only`.
//
// Two things it does not cover. The `afterEach` below stays on the suite-wide
// timeout, because bun applies a per-test ceiling to the body and leaves hooks on
// `--timeout`. And nothing inside these tests bounds the bootstrap more tightly
// than the ceiling does, so a deadlock in it reads exactly as a slow runner does.

afterEach(async () => {
  await disposeAllInstances()
})

const bootstrapFixture = Effect.gen(function* () {
  const dir = yield* tmpdirScoped({ git: true })
  const marker = path.join(dir, "config-hook-fired")
  const pluginFile = path.join(dir, "plugin.ts")
  yield* Effect.promise(() =>
    Bun.write(
      pluginFile,
      [
        `const MARKER = ${JSON.stringify(marker)}`,
        "export default async () => ({",
        "  config: async () => {",
        '    await Bun.write(MARKER, "ran")',
        "  },",
        "})",
        "",
      ].join("\n"),
    ),
  )
  yield* Effect.promise(() =>
    Bun.write(
      path.join(dir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: [pathToFileURL(pluginFile).href],
      }),
    ),
  )
  return { directory: dir, marker }
})

// Forked before `cliBootstrap`, so this window covers the cold start and not just the
// disposal that follows it. The 10s default left the test passing only while another had
// already paid the first bootstrap: run alone it failed here at 11.8s, blaming a disposal
// that had not been reached. Bounded under the test's own ceiling so this message still
// wins when it is a disposal that never arrives.
function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for CLI bootstrap instance disposal",
    timeout: 90_000,
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

it.live(
  "InstanceStore.provide runs InstanceBootstrap before effect",
  () =>
    Effect.gen(function* () {
      const tmp = yield* bootstrapFixture
      const store = yield* InstanceStore.Service

      yield* store.provide({ directory: tmp.directory }, Effect.succeed("ok"))

      expect(existsSync(tmp.marker)).toBe(true)
    }),
  120_000,
)

it.live(
  "CLI bootstrap runs InstanceBootstrap before callback",
  () =>
    Effect.gen(function* () {
      const tmp = yield* bootstrapFixture

      yield* Effect.promise(() => cliBootstrap(tmp.directory, async () => "ok"))

      expect(existsSync(tmp.marker)).toBe(true)
    }),
  120_000,
)

it.live(
  "CLI bootstrap disposes the instance when the callback rejects",
  () =>
    Effect.gen(function* () {
      const tmp = yield* bootstrapFixture
      const disposed = yield* waitDisposed(tmp.directory).pipe(Effect.forkScoped({ startImmediately: true }))

      const exit = yield* Effect.promise(() =>
        cliBootstrap(tmp.directory, async () => Promise.reject(new Error("boom"))),
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ message: "boom" })
      yield* Fiber.join(disposed)
    }),
  120_000,
)

it.live(
  "InstanceStore.reload runs InstanceBootstrap",
  () =>
    Effect.gen(function* () {
      const tmp = yield* bootstrapFixture
      const store = yield* InstanceStore.Service

      yield* store.reload({ directory: tmp.directory })

      expect(existsSync(tmp.marker)).toBe(true)
    }),
  120_000,
)
