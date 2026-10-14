import { describe, expect, test } from "bun:test"
import { SubagentOutput } from "@opencode/core/session/subagent-output"
import { SubagentCompletion } from "@opencode/core/session/subagent-completion"
import { Session } from "@opencode/core/session"

const fields: SubagentOutput.Field[] = [
  { name: "summary", description: "What was done", type: "string" },
  { name: "files", description: "Files touched", type: "array" },
]

describe("SubagentOutput.instruction", () => {
  test("names every field with its type", () => {
    const text = SubagentOutput.instruction(fields)
    expect(text).toContain("- summary (string): What was done")
    expect(text).toContain("- files (array): Files touched")
    expect(text).toContain("```json")
  })

  test("calls an undeclared type any", () => {
    expect(SubagentOutput.instruction([{ name: "result", description: "Anything" }])).toContain(
      "- result (any): Anything",
    )
  })
})

describe("SubagentOutput.parse", () => {
  test("reads the fenced block and ignores the prose around it", () => {
    const answer = [
      "I looked at the cache key path and fixed it.",
      "",
      "```json",
      '{ "summary": "fixed the cache key", "files": ["src/cache.ts"] }',
      "```",
    ].join("\n")

    expect(SubagentOutput.parse(answer, fields)).toEqual({
      ok: true,
      value: { summary: "fixed the cache key", files: ["src/cache.ts"] },
    })
  })

  test("takes the last block when the agent wrote several", () => {
    const answer = [
      "```json",
      '{ "summary": "draft", "files": [] }',
      "```",
      "On reflection:",
      "```json",
      '{ "summary": "final", "files": ["a.ts"] }',
      "```",
    ].join("\n")
    const parsed = SubagentOutput.parse(answer, fields)
    expect(parsed.ok && parsed.value.summary).toBe("final")
  })

  test("accepts a bare JSON answer with no fence", () => {
    expect(SubagentOutput.parse('{"summary":"done","files":[]}', fields).ok).toBe(true)
  })

  test("accepts the fence forms a subagent actually writes", () => {
    // Having done the work and answered correctly, a subagent should not fail the task over how it
    // spelled the fence.
    const cases = [
      '```\n{ "summary": "done", "files": [] }\n```',
      '```JSON\n{ "summary": "done", "files": [] }\n```',
      '```json { "summary": "done", "files": [] }```',
      'Here you go:\n```javascript\n{ "summary": "done", "files": [] }\n```',
    ]
    for (const answer of cases) {
      expect({ answer, ...SubagentOutput.parse(answer, fields) }).toMatchObject({ ok: true })
    }
  })

  test("names the fields the agent left out", () => {
    const parsed = SubagentOutput.parse('```json\n{ "summary": "done" }\n```', fields)
    expect(parsed).toEqual({ ok: false, error: "missing field: files" })
  })

  test("rejects a field of the wrong type", () => {
    const parsed = SubagentOutput.parse('```json\n{ "summary": "done", "files": "a.ts" }\n```', fields)
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.error).toContain("declared types")
  })

  test("rejects prose, a JSON array, and an empty answer", () => {
    expect(SubagentOutput.parse("I could not find anything.", fields).ok).toBe(false)
    expect(SubagentOutput.parse('```json\n["a"]\n```', fields).ok).toBe(false)
    expect(SubagentOutput.parse("   ", fields)).toEqual({ ok: false, error: "the subagent answered with nothing" })
  })

  test("leaves a value alone when no type is declared", () => {
    const parsed = SubagentOutput.parse('```json\n{ "result": { "nested": [1, 2] } }\n```', [
      { name: "result", description: "Anything" },
    ])
    expect(parsed.ok && parsed.value.result).toEqual({ nested: [1, 2] })
  })

  test("takes the JSON block even when another fenced block comes after it", () => {
    // A subagent that answers and then illustrates its work has done the task; reading the sample
    // as the answer would fail it for the one reason it cannot act on.
    const fields = [{ name: "summary", description: "what happened" }]
    for (const trailing of ["```ts\nconst x = 1\n```", "```diff\n- old\n+ new\n```", "Wrap output in ``` fences."]) {
      const parsed = SubagentOutput.parse(`\`\`\`json\n{"summary":"done"}\n\`\`\`\n${trailing}`, fields)
      expect(parsed).toMatchObject({ ok: true, value: { summary: "done" } })
    }
  })

  test("falls back to the last fenced block only when none is tagged as JSON", () => {
    const fields = [{ name: "summary", description: "what happened" }]
    expect(SubagentOutput.parse('```\n{"summary":"done"}\n```', fields)).toMatchObject({ ok: true })
    // `jsonc` is a tag a subagent reaches for as readily as `json`.
    expect(SubagentOutput.parse('```jsonc\n{"summary":"done"}\n```\n```ts\nconst x = 1\n```', fields)).toMatchObject({
      ok: true,
      value: { summary: "done" },
    })
    // Two JSON blocks: the last one is the answer, the earlier one a draft.
    expect(
      SubagentOutput.parse('```json\n{"summary":"draft"}\n```\n```json\n{"summary":"done"}\n```', fields),
    ).toMatchObject({ ok: true, value: { summary: "done" } })
  })
})

describe("SubagentCompletion.declared", () => {
  const child = Session.ID.make("ses_child")
  const answer = 'Done.\n```json\n{ "summary": "fixed", "files": ["a.ts"] }\n```'
  const note = SubagentCompletion.withLeftRunning("", child, [
    {
      id: "shell-dev",
      notificationID: "msg_note" as never,
      status: "running",
      recovery: { kind: "shell", sessionID: child, shellID: "shell-dev", command: "bun run dev" },
    },
  ]).trim()

  test("parses only the answer and reports what was left running after the fields", () => {
    const checked = SubagentCompletion.declared(`${answer}\n\n${note}`, fields, child)
    expect(checked).toEqual({
      ok: true,
      text: `${JSON.stringify({ summary: "fixed", files: ["a.ts"] }, null, 2)}\n\n${note}`,
    })
  })

  test("names the session and quotes the answer, not the note, when the fields are missing", () => {
    const checked = SubagentCompletion.declared(`I fixed it.\n\n${note}`, fields, child)
    expect(checked).toEqual({
      ok: false,
      message:
        "Subagent did not return the requested fields (sessionID: ses_child): the final block is not valid JSON. It answered: I fixed it.",
    })
  })

  test("passes an answer through when no fields were declared", () => {
    expect(SubagentCompletion.declared("prose", undefined, child)).toEqual({ ok: true, text: "prose" })
  })
})
