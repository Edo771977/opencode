import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionBudget } from "../../src/session/budget"

const turn = (agent: string, cost: number) =>
  ({ info: { role: "assistant", agent, cost }, parts: [] }) as unknown as SessionV1.WithParts

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

  test("a fresh session has spent nothing", () => {
    expect(SessionBudget.evaluate({ messages: [], agent: "build", budget: 1, stop: 2 })).toMatchObject({
      spent: 0,
      degrade: false,
      stop: false,
    })
  })
})
