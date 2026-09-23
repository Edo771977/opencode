import { describe, expect, test } from "bun:test"
import { TaskOutput } from "../../src/tool/task-output"

const fields: TaskOutput.Field[] = [
  { name: "summary", description: "What was done", type: "string" },
  { name: "files", description: "Files touched", type: "array" },
]

describe("TaskOutput.instruction", () => {
  test("names every field with its type", () => {
    const text = TaskOutput.instruction(fields)
    expect(text).toContain("- summary (string): What was done")
    expect(text).toContain("- files (array): Files touched")
    expect(text).toContain("```json")
  })

  test("calls an undeclared type any", () => {
    expect(TaskOutput.instruction([{ name: "result", description: "Anything" }])).toContain("- result (any): Anything")
  })
})

describe("TaskOutput.parse", () => {
  test("reads the fenced block and ignores the prose around it", () => {
    const answer = [
      "I looked at the cache key path and fixed it.",
      "",
      "```json",
      '{ "summary": "fixed the cache key", "files": ["src/cache.ts"] }',
      "```",
    ].join("\n")

    expect(TaskOutput.parse(answer, fields)).toEqual({
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
    const parsed = TaskOutput.parse(answer, fields)
    expect(parsed.ok && parsed.value.summary).toBe("final")
  })

  test("accepts a bare JSON answer with no fence", () => {
    expect(TaskOutput.parse('{"summary":"done","files":[]}', fields).ok).toBe(true)
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
      expect({ answer, ...TaskOutput.parse(answer, fields) }).toMatchObject({ ok: true })
    }
  })

  test("names the fields the agent left out", () => {
    const parsed = TaskOutput.parse('```json\n{ "summary": "done" }\n```', fields)
    expect(parsed).toEqual({ ok: false, error: "missing field: files" })
  })

  test("rejects a field of the wrong type", () => {
    const parsed = TaskOutput.parse('```json\n{ "summary": "done", "files": "a.ts" }\n```', fields)
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.error).toContain("declared types")
  })

  test("rejects prose, a JSON array, and an empty answer", () => {
    expect(TaskOutput.parse("I could not find anything.", fields).ok).toBe(false)
    expect(TaskOutput.parse('```json\n["a"]\n```', fields).ok).toBe(false)
    expect(TaskOutput.parse("   ", fields)).toEqual({ ok: false, error: "the subagent answered with nothing" })
  })

  test("leaves a value alone when no type is declared", () => {
    const parsed = TaskOutput.parse('```json\n{ "result": { "nested": [1, 2] } }\n```', [
      { name: "result", description: "Anything" },
    ])
    expect(parsed.ok && parsed.value.result).toEqual({ nested: [1, 2] })
  })

  test("takes the JSON block even when another fenced block comes after it", () => {
    // A subagent that answers and then illustrates its work has done the task; reading the sample
    // as the answer would fail it for the one reason it cannot act on.
    const fields = [{ name: "summary", description: "what happened" }]
    for (const trailing of ["```ts\nconst x = 1\n```", "```diff\n- old\n+ new\n```", "Wrap output in ``` fences."]) {
      const parsed = TaskOutput.parse(`\`\`\`json\n{"summary":"done"}\n\`\`\`\n${trailing}`, fields)
      expect(parsed).toMatchObject({ ok: true, value: { summary: "done" } })
    }
  })

  test("falls back to the last fenced block only when none is tagged as JSON", () => {
    const fields = [{ name: "summary", description: "what happened" }]
    expect(TaskOutput.parse('```\n{"summary":"done"}\n```', fields)).toMatchObject({ ok: true })
    // `jsonc` is a tag a subagent reaches for as readily as `json`.
    expect(TaskOutput.parse('```jsonc\n{"summary":"done"}\n```\n```ts\nconst x = 1\n```', fields)).toMatchObject({
      ok: true,
      value: { summary: "done" },
    })
    // Two JSON blocks: the last one is the answer, the earlier one a draft.
    expect(
      TaskOutput.parse('```json\n{"summary":"draft"}\n```\n```json\n{"summary":"done"}\n```', fields),
    ).toMatchObject({ ok: true, value: { summary: "done" } })
  })
})
