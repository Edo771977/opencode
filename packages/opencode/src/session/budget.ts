export * as SessionBudget from "./budget"

import type { SessionV1 } from "@opencode-ai/core/v1/session"

export type Decision = {
  /** Dollars this agent has spent in this session so far. */
  readonly spent: number
  /** The soft threshold was reached: run the rest of the session on the cheap model. */
  readonly degrade: boolean
  /** This is the step that reached it, so the agent is told once rather than every turn. */
  readonly crossed: boolean
  /** The ceiling was reached: stop after a final text-only turn. */
  readonly stop: boolean
}

/**
 * A budget says "work cheaply from here", not "stop". A run that has to carry a project to the end
 * cannot depend on someone noticing that it halted, so the soft threshold degrades the model and
 * the ceiling — which does halt — stays off unless an operator asks for it.
 *
 * Spend is counted per agent per session: switching agents mid-session gives each its own budget,
 * and a subagent's session carries only its own work.
 */
export function evaluate(input: {
  readonly messages: readonly SessionV1.WithParts[]
  readonly agent: string
  readonly budget: number | undefined
  readonly stop: number | undefined
}): Decision {
  const costs = input.messages.flatMap((message) =>
    message.info.role === "assistant" && message.info.agent === input.agent ? [message.info.cost] : [],
  )
  const spent = costs.reduce((total, cost) => total + cost, 0)
  // What was spent before the most recent turn, which is how a threshold reached now is told apart
  // from one reached several turns ago.
  const before = spent - (costs.at(-1) ?? 0)
  const reached = (limit: number | undefined) => limit !== undefined && spent >= limit
  return {
    spent,
    degrade: reached(input.budget),
    crossed: reached(input.budget) && input.budget !== undefined && before < input.budget,
    stop: reached(input.stop),
  }
}
