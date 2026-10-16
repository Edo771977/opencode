import { describe, expect } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { Pty } from "@opencode/core/pty"
import { AbsolutePath } from "@opencode/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Pty.node, Bus.node]), [
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/tmp") }))),
    ),
  ]),
)
const ptyTest = process.platform === "win32" ? it.live.skip : it.live

describe("pty event order", () => {
  ptyTest("publishes created before exited when the process exits during the created publish", () =>
    Effect.gen(function* () {
      const source = yield* Bus.Service
      const pty = yield* Pty.Service
      const seen = yield* Queue.unbounded<string>()

      // Publishing an event awaits every listener, so this one holds `created` open until the session
      // has exited: the exit lands inside the publish by construction. A fixed wait does not do that.
      // Fifty milliseconds were enough for `/bin/true` on an idle machine, and on a loaded CI runner
      // the process was still running when the publish returned, so the case under test never arose.
      yield* source.listen((event) =>
        event.type === Pty.Event.Created.type
          ? Effect.gen(function* () {
              while (!(yield* pty.list()).every((session) => session.status === "exited"))
                yield* Effect.sleep("5 millis")
            }).pipe(Effect.timeout("5 seconds"), Effect.ignore)
          : Effect.void,
      )
      // Registered second, so it observes the order the two publishes complete in rather than the
      // order they were started.
      yield* source.listen((event) => {
        if (event.type === Pty.Event.Created.type) Queue.offerUnsafe(seen, "created")
        if (event.type === Pty.Event.Exited.type) Queue.offerUnsafe(seen, "exited")
        return Effect.void
      })

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
