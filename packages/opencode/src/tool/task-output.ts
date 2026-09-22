export * as TaskOutput from "./task-output"

import { Option, Schema } from "effect"

/**
 * A subagent answers in prose, and the caller gets its last text block. That is enough for a person
 * reading along and too little for a caller that has to act on the answer, so a caller may instead
 * declare the fields it needs back. The subagent is told to end with one JSON object carrying them,
 * and the result is checked against that declaration before the caller ever sees it.
 *
 * Fields rather than a JSON Schema: a declared field list is a contract this can honor completely,
 * while accepting arbitrary schemas would mean implementing a fraction of JSON Schema and quietly
 * ignoring the rest.
 */
export const Field = Schema.Struct({
  name: Schema.String.annotate({ description: "Key the subagent must put in its JSON answer" }),
  description: Schema.String.annotate({ description: "What this field should contain" }),
  type: Schema.Literals(["string", "number", "boolean", "array", "object"])
    .annotate({ description: "Expected JSON type of the value. Defaults to accepting any type" })
    .pipe(Schema.optional),
})
export type Field = Schema.Schema.Type<typeof Field>

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

const schemaFor = (type: Field["type"]) => {
  if (type === "string") return Schema.String
  if (type === "number") return Schema.Finite
  if (type === "boolean") return Schema.Boolean
  if (type === "array") return Schema.Array(Schema.Unknown)
  if (type === "object") return Schema.Record(Schema.String, Schema.Unknown)
  return Schema.Unknown
}

export function instruction(fields: readonly Field[]) {
  return [
    "Your final message must end with a single fenced ```json block and nothing after it.",
    "The block must contain one JSON object with exactly these fields:",
    ...fields.map((field) => `- ${field.name} (${field.type ?? "any"}): ${field.description}`),
    "Write your reasoning before the block, never inside it.",
  ].join("\n")
}

/**
 * The block the answer's fields are in: the last one tagged as JSON, else the last fenced block of
 * any kind, else the whole answer.
 *
 * The tag decides before the position does. A subagent that writes the required block and then
 * illustrates its work with a code sample has done the task, and reading that sample as the answer
 * fails it for the one reason it cannot act on. The untagged fallback is for the opposite case, a
 * subagent that wrote a bare ```` ``` ```` fence and nothing else.
 */
function block(text: string) {
  const fences = [...text.matchAll(/```([a-zA-Z0-9_+-]*)[ \t]*\r?\n?([\s\S]*?)```/g)]
  const json = fences.filter((fence) => /^json[5c]?$/i.test(fence[1] ?? ""))
  const chosen = json.at(-1) ?? fences.at(-1)
  return (chosen?.[2] ?? text).trim()
}

export type Parsed =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: string }

/** What the subagent actually said, bounded, so a caller can tell a near miss from nonsense. */
export function excerpt(text: string, limit = 400) {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed
}

export function parse(text: string, fields: readonly Field[]): Parsed {
  const candidate = block(text)
  if (candidate.length === 0) return { ok: false, error: "the subagent answered with nothing" }

  const decoded = decodeJson(candidate)
  if (Option.isNone(decoded)) return { ok: false, error: "the final block is not valid JSON" }

  const value = decoded.value
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, error: "the final block is not a JSON object" }

  const missing = fields.filter((field) => !Object.hasOwn(value, field.name)).map((field) => field.name)
  if (missing.length)
    return { ok: false, error: `missing field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}` }

  const shape = Schema.Struct(Object.fromEntries(fields.map((field) => [field.name, schemaFor(field.type)])))
  if (Option.isNone(Schema.decodeUnknownOption(shape)(value)))
    return {
      ok: false,
      error: `fields do not have the declared types: ${fields.map((field) => `${field.name} (${field.type ?? "any"})`).join(", ")}`,
    }

  return { ok: true, value: value as Record<string, unknown> }
}
