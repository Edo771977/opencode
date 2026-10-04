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
// The `afterEach` below stays on the suite-wide timeout, because bun applies a
// per-test ceiling to the body and leaves hooks on `--timeout`, which is why one
// failure here drags the tests after it down too.
//
// What the ceiling cannot say is which step ran long, so a deadlock in the
// bootstrap and a runner two and a half times slower both read as
// `this test timed out after 120000ms`. The phases below report themselves for
// that reason (#20).

afterEach(async () => {
  await disposeAllInstances()
})

// #20 asked for a bound around the bootstrap's own phases, so that a deadlock and a slow runner
// stop reading alike. Measured here, a bound cannot do that job: `Effect.timeoutOrElse` has to
// interrupt what it bounds in order to fail, and interrupting `InstanceStore.provide` while the
// bootstrap is in flight does not come back. A 2 second bound on a provide that needs about 4.3
// fired, swallowed its own message, and let the test run to its ceiling and report
// `this test timed out after 60000ms` — the very message the bound existed to replace. The same
// test failing on a plain assertion after that provide had returned ends in 9s, so it is the
// interruption and not the failure. #20's second round reads the same way: the first test spent all
// 120 seconds and the two after it died in their hooks.
//
// So the phases announce themselves as they are reached and nothing is interrupted. When the
// ceiling kills a test, the log already says how far it got: no hook line puts the stop in config
// load or plugin bundling, which is where nearly all of a boundary's cost sits — measured here, the
// hook fires within a millisecond or two of the boundary returning, about 5s into the test that
// pays this process's first bootstrap and 74 to 107ms into one that does not. A hook line with no
// return line puts the stop in the short remainder after it, and the elapsed figures separate a
// runner that is slow from one that stopped.
//
// The fixture keeps a bound, because that one is proven to report: a stuck `git init` is
// interruptible, and breaking it on purpose does print this message. 20 seconds against the
// 78-175ms it measures across runs, and far enough under the 120s ceiling that it wins.
const FIXTURE_LIMIT = "20 seconds"

const boundary = <A, E, R>(tmp: { fixtureMs: number }, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = Date.now()
    console.log(`[bootstrap] fixture took ${tmp.fixtureMs}ms, entering the instance boundary`)
    const result = yield* effect
    console.log(`[bootstrap] the instance boundary returned ${Date.now() - started}ms in`)
    return result
  })

const bootstrapFixture = Effect.gen(function* () {
  const started = Date.now()
  const dir = yield* Effect.timeoutOrElse(tmpdirScoped({ git: true }), {
    duration: FIXTURE_LIMIT,
    orElse: () => Effect.fail(new Error("the temp git directory was never created")),
  })
  const marker = path.join(dir, "config-hook-fired")
  const pluginFile = path.join(dir, "plugin.ts")
  yield* Effect.promise(() =>
    Bun.write(
      pluginFile,
      [
        `const MARKER = ${JSON.stringify(marker)}`,
        "export default async () => ({",
        "  config: async () => {",
        // Said by the hook itself rather than observed from outside. A poll cannot see it reliably:
        // the hook fires within a millisecond or two of the boundary returning, so a watcher loses
        // the race and reports nothing in the very case where the line has to be trustworthy.
        '    console.log("[bootstrap] the plugin\'s config hook is running")',
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
  return { directory: dir, marker, fixtureMs: Date.now() - started }
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

      yield* boundary(tmp, store.provide({ directory: tmp.directory }, Effect.succeed("ok")))

      expect(existsSync(tmp.marker)).toBe(true)
    }),
  120_000,
)

it.live(
  "CLI bootstrap runs InstanceBootstrap before callback",
  () =>
    Effect.gen(function* () {
      const tmp = yield* bootstrapFixture

      yield* boundary(tmp, Effect.promise(() => cliBootstrap(tmp.directory, async () => "ok")))

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

      const exit = yield* boundary(
        tmp,
        Effect.promise(() => cliBootstrap(tmp.directory, async () => Promise.reject(new Error("boom")))).pipe(
          Effect.exit,
        ),
      )

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

      yield* boundary(tmp, store.reload({ directory: tmp.directory }))

      expect(existsSync(tmp.marker)).toBe(true)
    }),
  120_000,
)
