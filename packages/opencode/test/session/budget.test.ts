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

  test("the request begins at its own message, not at whichever is newest", () => {
    // What anything meaning "this request" has to be keyed on: the loop's own messages move the
    // newest one while a request runs, and a checkpoint keyed on that asks a second time.
    const human = user("msg_human")
    const queued = compaction(true, "msg_compaction")
    const carried = user("msg_continue")
    expect(
      SessionBudget.evaluate({
        messages: [human, turn("build", 5, "msg_human"), queued, carried],
        agent: "build",
        request: "msg_continue",
        budget: undefined,
        stop: undefined,
      }),
    ).toMatchObject({ requestOrigin: "msg_human" })

    // A message of the person's own begins its own request.
    expect(
      SessionBudget.evaluate({
        messages: [user("msg_first"), turn("build", 1, "msg_first"), user("msg_second")],
        agent: "build",
        request: "msg_second",
        budget: undefined,
        stop: undefined,
      }),
    ).toMatchObject({ requestOrigin: "msg_second" })
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

  test("a message with nothing the person wrote in it continues the request", () => {
    // How a background subagent's result reaches its caller, and how a command run as a subtask tells
    // the agent to carry on: a user message holding only what the runtime wrote for it to read.
    // Counted as a request of its own, an agent that has delegated buys another ceiling every time
    // something it started comes back, with nobody present.
    const human = user("msg_human")
    const delivered = user("msg_delivered", [{ type: "text", synthetic: true, text: "Background task completed" }])
    expect(
      SessionBudget.evaluate({
        messages: [human, turn("build", 5, "msg_human"), delivered, turn("build", 0.1, "msg_delivered")],
        agent: "build",
        request: "msg_delivered",
        budget: undefined,
        stop: 1,
      }),
    ).toMatchObject({ spentOnRequest: 5.1, stop: true, requestOrigin: "msg_human" })
  })

  test("a message the person wrote begins its own request, whatever the runtime added to it", () => {
    // Reminders are pushed onto the person's message rather than written as one of their own, so a
    // request is told from a continuation by what the person put in it, not by what is beside it.
    const reminded = user("msg_second", [
      { type: "text", text: "and now this" },
      { type: "text", synthetic: true, text: "<system-reminder>" },
    ])
    expect(
      SessionBudget.evaluate({
        messages: [user("msg_first"), turn("build", 5, "msg_first"), reminded],
        agent: "build",
        request: "msg_second",
        budget: undefined,
        stop: 1,
      }),
    ).toMatchObject({ spentOnRequest: 0, stop: false, requestOrigin: "msg_second" })
  })

  test("a request read before its parts were written is still the person's", () => {
    // Parts are written after the message they belong to. Read in that window a request has none, and
    // an empty message must not be taken for one the runtime wrote: that would cost a person's ask
    // its own allowance on a race.
    expect(
      SessionBudget.evaluate({
        messages: [user("msg_first"), turn("build", 5, "msg_first"), user("msg_second")],
        agent: "build",
        request: "msg_second",
        budget: undefined,
        stop: 1,
      }),
    ).toMatchObject({ spentOnRequest: 0, stop: false, requestOrigin: "msg_second" })
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
