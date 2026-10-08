import { expect } from "bun:test"
import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk"
import { Duration, Effect } from "effect"
import { childStartup, type AcpHandle } from "../../lib/cli-process"

type JsonRpcRequest = {
  readonly jsonrpc: "2.0"
  readonly id: number
  readonly method: string
  readonly params?: unknown
}

type JsonRpcResponse<T = unknown> = {
  readonly jsonrpc: "2.0"
  readonly id: number
  readonly result?: T
  readonly error?: unknown
}

type JsonRpcNotification<T = unknown> = {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly params?: T
}

export type AcpClient = {
  readonly request: <T>(method: string, params?: unknown) => Effect.Effect<JsonRpcResponse<T>, unknown>
  readonly receive: Effect.Effect<unknown>
  readonly waitForNotification: <T>(
    method: string,
    predicate: (params: T) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<JsonRpcNotification<T>, unknown>
}

export function createAcpClient(acp: AcpHandle): AcpClient {
  // `ready` flips on the first thing the child says, whatever it is. Until then a wait is measuring
  // the child's cold start as well as the exchange, and those are different quantities with different
  // budgets (#47) — which is why the steady-state bound below stays where it was. Raising both would
  // only hide the protocol regression the 15s one exists to catch.
  const state = { nextId: 1, ready: false }

  // #47: both waits below used to fail as a bare Effect `TimeoutError`, which cannot tell a child
  // that is slow to start from one that is wedged — and the auth test that misses this bound on
  // Windows declares no bound of its own, so that error was the whole report. Naming what was
  // awaited and attaching the child's `[acp-profile]` stderr is what makes a 15s timeout readable.
  const awaiting = <A, E>(effect: Effect.Effect<A, E>, what: string, duration: Duration.Duration) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: state.ready ? duration : childStartup,
        orElse: () =>
          Effect.fail(
            new Error(
              `waiting for ${what} from the acp child timed out${state.ready ? "" : ", and it had not spoken yet"}; its stderr:\n${acp.stderr()}`,
            ),
          ),
      }),
      Effect.tap(() =>
        Effect.sync(() => {
          state.ready = true
        }),
      ),
    )

  const request = <T>(method: string, params?: unknown) =>
    Effect.gen(function* () {
      const id = state.nextId++
      const message: JsonRpcRequest =
        params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params }
      yield* acp.send(message)

      while (true) {
        const received = yield* awaiting(acp.receive, `a response to ${method}`, Duration.seconds(15))
        if (isJsonRpcResponse<T>(received) && received.id === id) return received
      }
    })

  const waitForNotification = <T>(method: string, predicate: (params: T) => boolean, timeoutMs = 15_000) =>
    Effect.gen(function* () {
      while (true) {
        const received = yield* awaiting(acp.receive, `a ${method} notification`, Duration.millis(timeoutMs))
        if (!isJsonRpcNotification<T>(received)) continue
        if (received.method === method && predicate(received.params as T)) return received
      }
    })

  return {
    request,
    receive: acp.receive,
    waitForNotification,
  }
}

export function expectOk<T>(response: JsonRpcResponse<T>) {
  expect(response.error).toBeUndefined()
  expect(response.result).toBeDefined()
  return response.result as T
}

export function selectConfigOption(options: SessionConfigOption[] | null | undefined, id: string) {
  return options?.find(
    (option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.id === id && option.type === "select",
  )
}

export function firstAlternateValue(option: Extract<SessionConfigOption, { type: "select" }>) {
  return flattenSelectOptions(option).find((item) => item.value !== option.currentValue)?.value
}

export function flattenSelectOptions(option: Extract<SessionConfigOption, { type: "select" }>) {
  return option.options.flatMap((item): SessionConfigSelectOption[] => ("value" in item ? [item] : item.options))
}

function isJsonRpcResponse<T>(input: unknown): input is JsonRpcResponse<T> {
  if (!input || typeof input !== "object") return false
  return "id" in input && "jsonrpc" in input
}

function isJsonRpcNotification<T>(input: unknown): input is JsonRpcNotification<T> {
  if (!input || typeof input !== "object") return false
  return "method" in input && !("id" in input) && "jsonrpc" in input
}
