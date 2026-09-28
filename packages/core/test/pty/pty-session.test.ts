import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer, Queue } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Pty } from "@opencode-ai/core/pty"
import type { PtyID } from "@opencode-ai/core/pty/schema"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

type PtyEvent = { type: "created" | "exited" | "deleted"; id: PtyID }

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/tmp") })),
)
const configLayer = Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
    [Config.node, configLayer],
    [Location.node, locationLayer],
  ]),
)
const ptyTest = process.platform === "win32" ? it.live.skip : it.live

const subscribePtyEvents = Effect.fn("PtySessionTest.subscribePtyEvents")(function* () {
  const source = yield* EventV2.Service
  const events = yield* Queue.unbounded<PtyEvent>()
  const unsubscribe = yield* source.listen((event) => {
    if (event.type === Pty.Event.Created.type)
      Queue.offerUnsafe(events, { type: "created", id: (event.data as typeof Pty.Event.Created.data.Type).info.id })
    if (event.type === Pty.Event.Exited.type)
      Queue.offerUnsafe(events, { type: "exited", id: (event.data as typeof Pty.Event.Exited.data.Type).id })
    if (event.type === Pty.Event.Deleted.type)
      Queue.offerUnsafe(events, { type: "deleted", id: (event.data as typeof Pty.Event.Deleted.data.Type).id })
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsubscribe)
  return events
})

const createPty = Effect.fn("PtySessionTest.createPty")(function* (command: string, args: string[] = []) {
  const pty = yield* Pty.Service
  return yield* Effect.acquireRelease(
    pty.create({ command, args, cwd: "/tmp", env: { TERM: "xterm-256color", OPENCODE_TERMINAL: "1" } }),
    (info) => pty.remove(info.id).pipe(Effect.ignore),
  )
})

const waitForEvents = (events: Queue.Queue<PtyEvent>, id: PtyID, count: number) =>
  Effect.gen(function* () {
    const picked: Array<PtyEvent["type"]> = []
    while (picked.length < count) {
      const evt = yield* Queue.take(events)
      if (evt.id === id) picked.push(evt.type)
    }
    return picked
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new Error("timeout waiting for pty events")),
    }),
  )

const attachCollecting = Effect.fn("PtySessionTest.attachCollecting")(function* (id: PtyID, cursor?: number) {
  const pty = yield* Pty.Service
  const output = yield* Queue.unbounded<string>()
  const ended = yield* Deferred.make<{ exitCode?: number }>()
  const attachment = yield* pty.attach(id, {
    cursor,
    onData: (chunk) => Queue.offerUnsafe(output, chunk),
    onEnd: (event) => Deferred.doneUnsafe(ended, Effect.succeed(event)),
  })
  attachment.activate()
  return { attachment, output, ended }
})

const waitForOutput = (output: Queue.Queue<string>, text: string) =>
  Effect.gen(function* () {
    let received = ""
    while (!received.includes(text)) received += yield* Queue.take(output)
    return received
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new Error(`timeout waiting for output containing ${JSON.stringify(text)}`)),
    }),
  )

// `EXITED_LIMIT` in src/pty.ts, which is not exported. Changing it there fails the tests below
// loudly rather than quietly.
const EXITED_LIMIT = 25

// Exercising the cap needs one more exit than it retains, and those 26 short-lived sessions used to
// be 26 chances to lose one to #29 — bun-pty firing the exit of a process that finished before
// `spawn` returned at an emitter with no listeners yet — which failed both tests below six runs in
// ten. They worked around it by respawning a session that went quiet, on a budget. The loss is
// fixed in patches/bun-pty@0.4.8.patch, so the workaround is gone and a session that never reports
// its exit fails here again. Measured on four cores: without the patch these two tests pass when the
// machine is idle and fail 3 runs in 3 under three busy cores, which is what CI is; with it, 3 runs
// in 3 under the same load are green.
const EXIT_WAIT = "3 seconds"

const createExiting = Effect.fn("PtySessionTest.createExiting")(function* (count: number) {
  const pty = yield* Pty.Service
  return yield* Effect.forEach(Array.from({ length: count }), () =>
    Effect.gen(function* () {
      const info = yield* pty.create({ command: "/bin/true", cwd: "/tmp" })
      yield* Effect.gen(function* () {
        while ((yield* pty.get(info.id)).status === "running") yield* Effect.sleep("5 millis")
      }).pipe(
        Effect.timeoutOrElse({
          duration: EXIT_WAIT,
          orElse: () => Effect.fail(new Error(`session ${info.id} never reported an exit`)),
        }),
      )
      return info
    }),
  )
})

// Waits for the state an eviction produces, not for a bound on it. Two conditions that read as
// equivalent are not, and both passed against a cap doing nothing: `exited.length <= EXITED_LIMIT`
// holds before anything has exited at all, and `exited.length === EXITED_LIMIT` holds while a 26th
// session is still running and nothing has been evicted — exit detection is one poll loop per
// session, so the newest is regularly seen exited before an older one. Only an eviction brings the
// *total* down to the cap.
const waitForCap = (created: readonly Pty.Info[]) =>
  Effect.gen(function* () {
    const pty = yield* Pty.Service
    const newest = created[created.length - 1].id
    while (true) {
      const all = yield* pty.list()
      if (
        all.length === EXITED_LIMIT &&
        all.every((info) => info.status === "exited") &&
        all.some((info) => info.id === newest)
      )
        return all
      yield* Effect.sleep("20 millis")
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("retained sessions never settled at the cap")),
    }),
  )

describe("pty", () => {
  it.live("returns typed not found errors for missing sessions", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const id = "pty_missing" as PtyID

      for (const result of [
        yield* pty.get(id).pipe(Effect.asVoid, Effect.exit),
        yield* pty.update(id, { title: "missing" }).pipe(Effect.asVoid, Effect.exit),
        yield* pty.remove(id).pipe(Effect.exit),
        yield* pty.write(id, "input").pipe(Effect.exit),
        yield* pty.attach(id, { onData: () => {}, onEnd: () => {} }).pipe(Effect.asVoid, Effect.exit),
      ]) {
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result))
          expect(Cause.squash(result.cause)).toMatchObject({ _tag: "Pty.NotFoundError", ptyID: id })
      }
    }),
  )

  ptyTest("retains exited sessions until removed", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const events = yield* subscribePtyEvents()
      const info = yield* createPty("/usr/bin/env", ["sh", "-c", "exit 3"])

      expect(yield* waitForEvents(events, info.id, 2)).toEqual(["created", "exited"])
      const exited = yield* pty.get(info.id)
      expect(exited.status).toBe("exited")
      expect(exited.exitCode).toBe(3)

      yield* pty.remove(info.id)
      expect(yield* waitForEvents(events, info.id, 1)).toEqual(["deleted"])
      const missing = yield* pty.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(missing)).toBe(true)
    }),
  )

  // Nothing covered the retention cap before these two, so nothing would have noticed it failing to
  // trim at all.
  ptyTest(
    "trims retained sessions down to the cap",
    () =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const created = yield* createExiting(26)
        const retained = yield* waitForCap(created)
        expect(retained.length).toBe(EXITED_LIMIT)
        yield* Effect.forEach(retained, (info) => pty.remove(info.id).pipe(Effect.ignore))
      }),
    30_000,
  )

  // A consumer is allowed to call back into the service from `onEnd`, and `attach` says those
  // callbacks run synchronously from the PTY's own data path. One that removes the session runs
  // while the exit handler has not yet recorded the id, so the removal finds nothing to unrecord and
  // the handler then records an id no session answers to. Left on the head of the ordering list, an
  // id like that was retried forever and the cap never trimmed again.
  ptyTest(
    "keeps the cap working after a consumer removes a session from its end callback",
    () =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const context = yield* Effect.context()
        const runFork = Effect.runForkWith(context)
        const victim = yield* pty.create({ command: "cat", cwd: "/tmp" })
        const attachment = yield* pty.attach(victim.id, {
          onData: () => {},
          onEnd: () => void runFork(pty.remove(victim.id).pipe(Effect.ignore)),
        })
        attachment.activate()

        yield* pty.write(victim.id, "\u0004")
        yield* Effect.gen(function* () {
          while (Exit.isSuccess(yield* pty.get(victim.id).pipe(Effect.exit))) yield* Effect.sleep("20 millis")
        }).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.fail(new Error("the end callback never removed its session")),
          }),
        )

        const created = yield* createExiting(26)
        const retained = yield* waitForCap(created)
        expect(retained.length).toBe(EXITED_LIMIT)
        yield* Effect.forEach(retained, (info) => pty.remove(info.id).pipe(Effect.ignore))
      }),
    30_000,
  )

  ptyTest("replays buffered output and streams live output to attachments", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* createPty("cat")
      yield* pty.write(info.id, "AAA\n")

      const first = yield* attachCollecting(info.id)
      expect(yield* waitForOutput(first.output, "AAA")).toContain("AAA")

      first.attachment.write("BBB\n")
      yield* waitForOutput(first.output, "BBB")

      // A later attachment replays everything already buffered.
      const replayed = yield* attachCollecting(info.id)
      expect(replayed.attachment.replay).toContain("AAA")
      expect(replayed.attachment.replay).toContain("BBB")
      expect(replayed.attachment.cursor).toBeGreaterThan(0)

      // Tail attachments skip the buffer and only see subsequent output.
      const tail = yield* attachCollecting(info.id, -1)
      expect(tail.attachment.replay).toBe("")
      expect(tail.attachment.cursor).toBe(replayed.attachment.cursor)
    }),
  )

  ptyTest("stops delivering output after detach", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* createPty("cat")
      const attached = yield* attachCollecting(info.id, -1)

      attached.attachment.detach()
      yield* pty.write(info.id, "AAA\n")

      const verify = yield* attachCollecting(info.id)
      yield* waitForOutput(verify.output, "AAA")
      const leaked = yield* Queue.poll(attached.output)
      expect(leaked._tag).toBe("None")
    }),
  )

  ptyTest("isolates output between sessions", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const a = yield* createPty("cat")
      const b = yield* createPty("cat")
      const attachedA = yield* attachCollecting(a.id)
      const attachedB = yield* attachCollecting(b.id)

      yield* pty.write(a.id, "AAA\n")
      yield* waitForOutput(attachedA.output, "AAA")

      const leaked = yield* Queue.poll(attachedB.output)
      expect(leaked._tag).toBe("None")
    }),
  )

  ptyTest("notifies attachments with the exit code and rejects attach after exit", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const events = yield* subscribePtyEvents()
      const info = yield* createPty("cat")
      const attached = yield* attachCollecting(info.id)

      yield* pty.write(info.id, "\u0004")
      expect(yield* Deferred.await(attached.ended).pipe(Effect.timeout("5 seconds"))).toEqual({ exitCode: 0 })
      yield* waitForEvents(events, info.id, 2)

      const result = yield* pty.attach(info.id, { onData: () => {}, onEnd: () => {} }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result))
        expect(Cause.squash(result.cause)).toMatchObject({ _tag: "Pty.ExitedError", ptyID: info.id })
    }),
  )
})

const configuredShell = process.platform === "win32" ? undefined : Bun.which("bash")
const configuredIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
    [
      Config.node,
      Layer.mock(Config.Service)({
        entries: () =>
          Effect.succeed(
            configuredShell
              ? [new Config.Document({ type: "document", info: new Config.Info({ shell: configuredShell }) })]
              : [],
          ),
      }),
    ],
    [Location.node, locationLayer],
  ]),
)
const configuredTest = process.platform === "win32" ? configuredIt.live.skip : configuredIt.live

describe("pty create defaults", () => {
  configuredTest("defaults command, login args, and cwd from config and location", () =>
    Effect.gen(function* () {
      if (!configuredShell) return
      const pty = yield* Pty.Service
      const info = yield* Effect.acquireRelease(pty.create({ title: "configured" }), (created) =>
        pty.remove(created.id).pipe(Effect.ignore),
      )
      expect(info.command).toBe(configuredShell)
      expect(info.args).toEqual(["-l"])
      expect(info.cwd).toBe("/tmp")
      expect(info.title).toBe("configured")
    }),
  )
})
