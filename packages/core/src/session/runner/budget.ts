export * as SessionBudgetPrompt from "./budget"

/**
 * Crossing the budget changes how an agent works rather than whether it works. A run meant to carry
 * a project to the end cannot depend on someone noticing that it stopped, so the agent keeps going
 * on the cheap model and is told to spend what is left carefully.
 */
export const notice = (input: { spent: number; budget: number; model: string | undefined }) =>
  [
    "BUDGET REACHED",
    "",
    `This agent has spent $${input.spent.toFixed(2)} of its $${input.budget.toFixed(2)} budget for this session.`,
    ...(input.model === undefined
      ? ["No cheaper model is available, so you continue on the current one."]
      : [`Your remaining turns run on ${input.model}, a cheaper and less capable model.`]),
    "",
    "Keep working, and spend what is left where it matters:",
    "- Finish the line of work you are on instead of opening a new one",
    "- Prefer reading precisely over searching broadly",
    "- Do not re-verify what you have already verified",
    "- Say so plainly in your final answer if what remains cannot be done well at this budget",
  ].join("\n")

/**
 * The ceiling, off unless an operator asks for it. Worth setting on a subagent, whose caller can
 * read the partial result and decide what to do; on a primary agent it stops the run outright.
 */
export const EXHAUSTED_PROMPT = `CRITICAL - BUDGET EXHAUSTED

This agent has spent its entire budget for this session. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that the budget for this agent has been exhausted
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY.`
