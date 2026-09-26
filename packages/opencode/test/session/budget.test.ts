import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionBudget } from "../../src/session/budget"

// The user message the agent is answering. Turns carry it as their `parentID`, which is how the
// ceiling tells this request's spend from the session's.
const REQUEST = "msg_request"

let clock = 0
const turn = (agent: string, cost: number, parentID = REQUEST) =>
  ({
    info: { role: "assistant", agent, cost, parentID, id: `msg_${++clock}`, time: { created: clock } },
    parts: [],
  }) as unknown as SessionV1.WithParts

const user = (id = REQUEST, parts: unknown[] = []) =>
  ({ info: { role: "user", id, time: { created: ++clock } }, parts }) as unknown as SessionV1.WithParts

// The loop queues a compaction as a user message of its own, carrying the part that describes it.
const compaction = (auto: boolean, id: string) => user(id, [{ type: "compaction", auto }])

describe("SessionBudget.evaluate", () => {
  test("counts only what this agent spent in this session", () => {
    const decision = SessionBudget.evaluate({
      messages: [turn("build", 0.4), user(), turn("reviewer", 5), turn("build", 0.3)],
      agent: "build",
      request: REQUEST,
      budget: undefined,
      stop: undefined,
    })
    expect(decision.spent).toBeCloseTo(0.7)
    expect(decision.degrade).toBe(false)
    expect(decision.stop).toBe(false)
  })

  test("degrades once the budget is reached and keeps degrading after", () => {
    const reached = SessionBudget.evaluate({
      messages: [turn("build", 0.6), turn("build", 0.5)],
      agent: "build",
      request: REQUEST,
      budget: 1,
      stop: undefined,
    })
    expect(reached).toMatchObject({ degrade: true, crossed: true, stop: false })

    // A later turn is still over budget, but the agent has already been told.
    const later = SessionBudget.evaluate({
      messages: [turn("build", 0.6), turn("build", 0.5), turn("build", 0.1)],
      agent: "build",
      request: REQUEST,
      budget: 1,
      stop: undefined,
    })
    expect(later).toMatchObject({ degrade: true, crossed: false, stop: false })
  })

  test("does not degrade below the budget", () => {
    expect(
      SessionBudget.evaluate({
        messages: [turn("build", 0.9)],
        agent: "build",
        request: REQUEST,
        budget: 1,
        stop: undefined,
      }),
    ).toMatchObject({ degrade: false, crossed: false })
  })

  test("stops only when a ceiling is configured and reached", () => {
    const messages = [turn("build", 2.5)]
    expect(
      SessionBudget.evaluate({ messages, agent: "build", request: REQUEST, budget: 1, stop: undefined }).stop,
    ).toBe(false)
    expect(SessionBudget.evaluate({ messages, agent: "build", request: REQUEST, budget: 1, stop: 5 }).stop).toBe(false)
    expect(SessionBudget.evaluate({ messages, agent: "build", request: REQUEST, budget: 1, stop: 2 }).stop).toBe(true)
  })

  test("an agent with no budget is never degraded or stopped", () => {
    expect(
      SessionBudget.evaluate({
        messages: [turn("build", 100)],
        agent: "build",
        request: REQUEST,
        budget: undefined,
        stop: undefined,
      }),
    ).toMatchObject({ spent: 100, degrade: false, crossed: false, stop: false })
  })

  test("reads the same turn as the most recent whichever order history arrives in", () => {
    // `MessageV2.stream` hands back newest first and `filterCompacted` oldest first. Taking the
    // last element of the list would read the wrong turn in one of the two, which decides nothing
    // less than whether the agent is told about its budget once, every turn, or never.
    const spread = [turn("build", 0.9), turn("build", 0.2), turn("build", 0.2)]
    for (const messages of [spread, [...spread].reverse()])
      expect(
        SessionBudget.evaluate({ messages, agent: "build", request: REQUEST, budget: 1, stop: undefined }),
      ).toMatchObject({
        degrade: true,
        crossed: false,
      })

    const crossedNow = [turn("build", 0.1), turn("build", 1)]
    for (const messages of [crossedNow, [...crossedNow].reverse()])
      expect(
        SessionBudget.evaluate({ messages, agent: "build", request: REQUEST, budget: 1, stop: undefined }),
      ).toMatchObject({
        degrade: true,
        crossed: true,
      })
  })

  test("the ceiling reads the request in hand, not the whole session", () => {
    // The defect this replaced: a request that overspent left the session unable to work again.
    // Spend never goes down, so every later request re-read the same total, was answered by a
    // summary that cost more than the last, and drifted further past a ceiling it could not leave.
    expect(
      SessionBudget.evaluate({
        messages: [turn("build", 5, "msg_earlier"), user()],
        agent: "build",
        request: REQUEST,
        budget: undefined,
        stop: 1,
      }),
    ).toMatchObject({ spent: 5, spentOnRequest: 0, stop: false })
  })

  test("stops a request whose own turns reached the ceiling", () => {
    expect(
      SessionBudget.evaluate({
        messages: [turn("build", 5, "msg_earlier"), turn("build", 0.6), turn("build", 0.5)],
        agent: "build",
        request: REQUEST,
        budget: undefined,
        stop: 1,
      }),
    ).toMatchObject({ spentOnRequest: 1.1, stop: true })
  })

  test("degrades on the session while the ceiling still reads only this request", () => {
    // Two thresholds, two units: the session is long past its budget, the request in hand has
    // barely started, so the agent works cheaply rather than not at all.
    expect(
      SessionBudget.evaluate({
        messages: [turn("build", 5, "msg_earlier"), turn("build", 0.2)],
        agent: "build",
        request: REQUEST,
        budget: 1,
        stop: 1,
      }),
    ).toMatchObject({ spent: 5.2, spentOnRequest: 0.2, degrade: true, stop: false })
  })

  test("an automatic compaction does not hand the request a fresh allowance", () => {
    // Both of the loop's own user messages: the compaction it queued, and the continuation that
    // compaction wrote. Counted as requests of their own, a run would buy itself another ceiling
    // every time it compacted — which is every time it needed to keep going.
    const human = user("msg_human")
    const queued = compaction(true, "msg_compaction")
    const carried = user("msg_continue")
    expect(
      SessionBudget.evaluate({
        messages: [human, turn("build", 5, "msg_human"), queued, carried, turn("build", 0.1, "msg_continue")],
        agent: "build",
        request: "msg_continue",
        budget: undefined,
        stop: 1,
      }),
    ).toMatchObject({ spentOnRequest: 5.1, stop: true })
  })

  test("a manual compaction ends the chain", () => {
    // It queues its own message but writes no continuation, so what follows is the person's ask.
    const human = user("msg_human")
    const queued = compaction(false, "msg_compaction")
    const next = user("msg_next")
    expect(
      SessionBudget.evaluate({
        messages: [human, turn("build", 5, "msg_human"), queued, next],
        agent: "build",
        request: "msg_next",
        budget: undefined,
        stop: 1,
      }),
    ).toMatchObject({ spentOnRequest: 0, stop: false })
  })

  test("another agent's turns on the same request are not counted", () => {
    expect(
      SessionBudget.evaluate({
        messages: [user(), turn("build", 0.2), turn("reviewer", 9)],
        agent: "build",
        request: REQUEST,
        budget: 1,
        stop: 1,
      }),
    ).toMatchObject({ spent: 0.2, spentOnRequest: 0.2, degrade: false, stop: false })
  })

  test("checks in at every multiple of the budget, not only the first", () => {
    // What makes an answered checkpoint buy another budget's worth rather than lift the budget for
    // good. `crossed` stays the first crossing alone: that one is a notice, and it is told once.
    const base = { agent: "build", request: REQUEST, budget: 1, stop: undefined } as const
    expect(SessionBudget.evaluate({ ...base, messages: [turn("build", 0.6), turn("build", 0.5)] })).toMatchObject({
      crossed: true,
      checkpoint: true,
    })

    // Past the budget, not past the next multiple: nothing to ask about yet.
    expect(SessionBudget.evaluate({ ...base, messages: [turn("build", 1.1), turn("build", 0.2)] })).toMatchObject({
      crossed: false,
      checkpoint: false,
    })

    // The turn that passes twice the budget asks again.
    expect(SessionBudget.evaluate({ ...base, messages: [turn("build", 1.5), turn("build", 0.6)] })).toMatchObject({
      crossed: false,
      checkpoint: true,
    })
  })

  test("a fresh session has spent nothing", () => {
    expect(
      SessionBudget.evaluate({ messages: [], agent: "build", request: REQUEST, budget: 1, stop: 2 }),
    ).toMatchObject({
      spent: 0,
      degrade: false,
      stop: false,
    })
  })
})
