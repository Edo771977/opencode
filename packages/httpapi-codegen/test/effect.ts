import { test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import type { Scope } from "effect/Scope"
import { TestClock, TestConsole } from "effect/testing"

type Body<A, E, R> = Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>)

const layer = Layer.mergeAll(TestConsole.layer, TestClock.layer())

// Effect's default logger writes through the Console service, which the test
// environments replace with TestConsole. Without this, a failing test printed
// its assertion and none of the logs that led to it, with no sign that any had
// been captured. Read the capture back while that console is still current.
const capturedOutput = TestConsole.testConsoleWith((testConsole) =>
  Effect.gen(function* () {
    if (testConsole.logLines === undefined) return [] as ReadonlyArray<unknown>
    return [...(yield* testConsole.logLines), ...(yield* testConsole.errorLines)]
  }),
)

// Printed verbatim rather than through Effect.logError, which would stamp each
// replayed line as a fresh error of its own. One console call contributes one
// entry per parameter, so these are the arguments the logger passed, not lines.
function replay(captured: ReadonlyArray<unknown>) {
  if (captured.length === 0) return
  console.error("--- console output captured during the failing test ---")
  for (const entry of captured) console.error(entry)
  console.error("--- end of captured output ---")
}

const effect = <A, E>(name: string, body: Body<A, E, Scope>, options?: Parameters<typeof test>[2]) =>
  test(
    name,
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          const exit = yield* Effect.suspend(() => (typeof body === "function" ? body() : body)).pipe(
            Effect.scoped,
            Effect.exit,
          )
          if (Exit.isSuccess(exit)) return { exit, logs: [] as ReadonlyArray<unknown> }
          return { exit, logs: yield* capturedOutput }
        }).pipe(Effect.provide(layer))
        if (Exit.isFailure(result.exit)) {
          replay(result.logs)
          yield* Effect.forEach(Cause.prettyErrors(result.exit.cause), Effect.logError, { discard: true })
        }
        return yield* result.exit
      }).pipe(Effect.runPromise),
    options,
  )

export const it = { effect }
