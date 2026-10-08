import { describe, expect } from "bun:test"
import type {
  CloseSessionResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  ResumeSessionResponse,
} from "@agentclientprotocol/sdk"
import { Effect } from "effect"
import { childStartup, cliIt } from "../../lib/cli-process"
import { expectOk, selectConfigOption } from "./acp-test-client"
import { createAcpClient, initialize, newSession, verifierConfig } from "./helpers"

describe("opencode acp lifecycle subprocess", () => {
  cliIt.live(
    "stdin EOF exits cleanly",
    ({ opencode }) =>
      Effect.gen(function* () {
        const acp = yield* opencode.acp()
        acp.close()

        // #47: stdin is closed before the child has started, so this one wait covers the whole cold
        // start — bun, the imports, `Server.listen`, the stdin handlers — and only then the exit. It
        // gets the startup budget rather than the round-trip one for that reason, not because 15s was
        // unlucky. It still reports the child's own `[acp-profile]` marks, which is what distinguishes
        // a start that ran long from an EOF that was never seen.
        const code = yield* Effect.promise(() => acp.exited).pipe(
          Effect.timeoutOrElse({
            duration: childStartup,
            orElse: () =>
              Effect.fail(
                new Error(`the acp child had not exited 15s after its stdin closed; its stderr:\n${acp.stderr()}`),
              ),
          }),
        )
        expect(code).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "close capability and close request",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        const initialized = yield* initialize(acp)
        expect(initialized.agentCapabilities?.sessionCapabilities?.close).toEqual({})

        const session = yield* newSession(acp, home)
        expectOk(yield* acp.request<CloseSessionResponse>("session/close", { sessionId: session.sessionId }))
      }),
    60_000,
  )

  cliIt.live(
    "loadSession capability and load request return session config options",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        const initialized = yield* initialize(acp)
        expect(initialized.agentCapabilities?.loadSession).toBe(true)
        const session = yield* newSession(acp, home)
        const loaded = expectOk(
          yield* acp.request<LoadSessionResponse>("session/load", {
            cwd: home,
            sessionId: session.sessionId,
            mcpServers: [],
          }),
        )

        expect(selectConfigOption(loaded.configOptions, "model")?.category).toBe("model")
      }),
    60_000,
  )

  cliIt.live(
    "list request includes a live ACP-created session",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)
        const listed = expectOk(yield* acp.request<ListSessionsResponse>("session/list", { cwd: home }))

        expect(listed.sessions.some((item) => item.sessionId === session.sessionId)).toBe(true)
      }),
    60_000,
  )

  cliIt.live(
    "resume capability advertisement",
    ({ opencode }) =>
      Effect.gen(function* () {
        const initialized = yield* initialize(yield* createAcpClient({ opencode }))

        expect(initialized.agentCapabilities?.sessionCapabilities?.resume).toEqual({})
      }),
    60_000,
  )

  cliIt.live(
    "resume request returns session config options",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)
        const resumed = expectOk(
          yield* acp.request<ResumeSessionResponse>("session/resume", {
            cwd: home,
            sessionId: session.sessionId,
            mcpServers: [],
          }),
        )

        expect(selectConfigOption(resumed.configOptions, "model")?.category).toBe("model")
      }),
    60_000,
  )
})
