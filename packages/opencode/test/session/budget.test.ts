import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionBudget } from "../../src/session/budget"

let clock = 0
const turn = (agent: string, cost: number) =>
  ({
    info: { role: "assistant", agent, cost, id: `msg_${++clock}`, time: { created: clock } },
    parts: [],
  }) as unknown as SessionV1.WithParts

const user = () => ({ info: { role: "user" }, parts: [] }) as unknown as SessionV1.WithParts

describe("SessionBudget.evaluate", () => {
  test("counts only what this agent spent in this session", () => {
    const decision = SessionBudget.evaluate({
      messages: [turn("build", 0.4), user(), turn("reviewer", 5), turn("build", 0.3)],
      agent: "build",
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
      budget: 1,
      stop: undefined,
    })
    expect(reached).toMatchObject({ degrade: true, crossed: true, stop: false })

    // A later turn is still over budget, but the agent has already been told.
    const later = SessionBudget.evaluate({
      messages: [turn("build", 0.6), turn("build", 0.5), turn("build", 0.1)],
      agent: "build",
      budget: 1,
      stop: undefined,
    })
    expect(later).toMatchObject({ degrade: true, crossed: false, stop: false })
  })

  test("does not degrade below the budget", () => {
    expect(
      SessionBudget.evaluate({ messages: [turn("build", 0.9)], agent: "build", budget: 1, stop: undefined }),
    ).toMatchObject({ degrade: false, crossed: false })
  })

  test("stops only when a ceiling is configured and reached", () => {
    const messages = [turn("build", 2.5)]
    expect(SessionBudget.evaluate({ messages, agent: "build", budget: 1, stop: undefined }).stop).toBe(false)
    expect(SessionBudget.evaluate({ messages, agent: "build", budget: 1, stop: 5 }).stop).toBe(false)
    expect(SessionBudget.evaluate({ messages, agent: "build", budget: 1, stop: 2 }).stop).toBe(true)
  })

  test("an agent with no budget is never degraded or stopped", () => {
    expect(
      SessionBudget.evaluate({
        messages: [turn("build", 100)],
        agent: "build",
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
      expect(SessionBudget.evaluate({ messages, agent: "build", budget: 1, stop: undefined })).toMatchObject({
        degrade: true,
        crossed: false,
      })

    const crossedNow = [turn("build", 0.1), turn("build", 1)]
    for (const messages of [crossedNow, [...crossedNow].reverse()])
      expect(SessionBudget.evaluate({ messages, agent: "build", budget: 1, stop: undefined })).toMatchObject({
        degrade: true,
        crossed: true,
      })
  })

  test("a fresh session has spent nothing", () => {
    expect(SessionBudget.evaluate({ messages: [], agent: "build", budget: 1, stop: 2 })).toMatchObject({
      spent: 0,
      degrade: false,
      stop: false,
    })
  })
})
