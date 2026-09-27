import { describe, expect } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Pty } from "@opencode-ai/core/pty"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
    [Config.node, Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })],
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/tmp") }))),
    ],
  ]),
)
const ptyTest = process.platform === "win32" ? it.live.skip : it.live

describe("pty event order", () => {
  ptyTest("publishes created before exited when the process exits during the created publish", () =>
    Effect.gen(function* () {
      const source = yield* EventV2.Service
      const seen = yield* Queue.unbounded<string>()

      // Publishing an event awaits every listener, so this one holds `created` open for 50ms — long
      // enough that a process which exits in about a millisecond, observed by bun-pty's 8ms poll,
      // has certainly exited before the publish returns. No sleep in the test decides the outcome:
      // it is this listener that puts the exit inside the window, by construction.
      yield* source.listen((event) => (event.type === Pty.Event.Created.type ? Effect.sleep("50 millis") : Effect.void))
      // Registered second, so it observes the order the two publishes complete in rather than the
      // order they were started.
      yield* source.listen((event) => {
        if (event.type === Pty.Event.Created.type) Queue.offerUnsafe(seen, "created")
        if (event.type === Pty.Event.Exited.type) Queue.offerUnsafe(seen, "exited")
        return Effect.void
      })

      const pty = yield* Pty.Service
      const info = yield* Effect.acquireRelease(pty.create({ command: "/bin/true", cwd: "/tmp" }), (created) =>
        pty.remove(created.id).pipe(Effect.ignore),
      )
      expect(info.status).toBe("exited")

      const order = yield* Effect.all([Queue.take(seen), Queue.take(seen)]).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error("the created and exited events did not both arrive")),
        }),
      )
      expect(order).toEqual(["created", "exited"])
    }),
  )
})
