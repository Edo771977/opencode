export * as SessionBudgetPrompt from "./budget"

const ADVICE = [
  "Keep working, and spend what is left where it matters:",
  "- Finish the line of work you are on instead of opening a new one",
  "- Prefer reading precisely over searching broadly",
  "- Do not re-verify what you have already verified",
  "- Say so plainly in your final answer if what remains cannot be done well at this budget",
]

const spentLine = (input: { spent: number; budget: number }) =>
  `This agent has spent $${input.spent.toFixed(2)} of its $${input.budget.toFixed(2)} budget for this session.`

/**
 * Crossing the budget changes how an agent works rather than whether it works. A run meant to carry
 * a project to the end cannot depend on someone noticing that it stopped, so the agent keeps going
 * on the cheap model and is told to spend what is left carefully.
 */
export const notice = (input: { spent: number; budget: number; model: string | undefined }) =>
  [
    "BUDGET REACHED",
    "",
    spentLine(input),
    ...(input.model === undefined
      ? ["No cheaper model is available, so you continue on the current one."]
      : [`Your remaining turns run on ${input.model}, a cheaper and less capable model.`]),
    "",
    ...ADVICE,
  ].join("\n")

/**
 * What the agent is told when the budget was a checkpoint and the person said to keep going. It
 * keeps the model and the tools it had — degrading a run somebody just paid to continue would answer
 * a question nobody asked — so the only thing to say is what it has cost and to spend the rest well.
 */
export const authorized = (input: { spent: number; budget: number }) =>
  [
    "BUDGET REACHED",
    "",
    spentLine(input),
    "You were asked whether to keep going and the answer was yes, so you continue as you are.",
    "",
    ...ADVICE,
  ].join("\n")

/**
 * The ceiling, off unless an operator asks for it. It bounds one request rather than the session:
 * the turn that reaches it summarizes instead of working, and the next user message starts over
 * with its tools. Worth setting on a subagent, whose caller reads that summary and decides what to
 * do next; on a primary agent it hands the same decision back to the person at the keyboard.
 */
export const EXHAUSTED_PROMPT = textOnly({
  heading: "CRITICAL - BUDGET EXHAUSTED",
  opening:
    "This request has reached the ceiling set on what one request may spend. Tools are disabled for the rest of it, and come back with the next message from the user.",
  statement: "Statement that this request has reached its spending ceiling",
})

/**
 * What the agent is told when the budget was a checkpoint and the person said no. The run ends here
 * the way the ceiling ends one, except that somebody chose it, so the summary is what they will read
 * to decide what happens next.
 */
export const declined = (input: { spent: number; budget: number; feedback: string | undefined }) =>
  textOnly({
    heading: "CRITICAL - BUDGET NOT EXTENDED",
    opening: [
      spentLine(input),
      "You were asked whether to keep going and the answer was no.",
      // Quoted: their words run straight into the sentence that forbids tools otherwise.
      ...(input.feedback === undefined ? [] : [`What they said: "${input.feedback}"`]),
      "Tools are disabled for the rest of this request.",
    ].join(" "),
    statement: "Statement that the budget was reached and not extended",
  })

/**
 * The shape both endings share: one turn, no tools, and a summary written for whoever has to decide
 * what happens next. Kept in one place because a model that is told it may not call tools while
 * being handed tool definitions will try anyway, and the wording is what stops it.
 */
function textOnly(input: { heading: string; opening: string; statement: string }) {
  return `${input.heading}

${input.opening} Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- ${input.statement}
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next, so whoever reads this can decide whether to continue

Any attempt to use tools is a critical violation. Respond with text ONLY.`
}
