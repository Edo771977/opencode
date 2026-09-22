import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

const decode = Schema.decodeUnknownSync(ModelV2.Ref)

describe("ModelV2.Ref", () => {
  test("accepts a model selection without a variant", () => {
    expect(decode({ id: "claude-sonnet", providerID: "anthropic" })).toEqual({
      id: ModelV2.ID.make("claude-sonnet"),
      providerID: ProviderV2.ID.make("anthropic"),
    })
  })

  test("preserves an explicit model variant", () => {
    expect(decode({ id: "claude-sonnet", providerID: "anthropic", variant: "high" })).toEqual({
      id: ModelV2.ID.make("claude-sonnet"),
      providerID: ProviderV2.ID.make("anthropic"),
      variant: ModelV2.VariantID.make("high"),
    })
  })
})

describe("ModelV2.parseRef", () => {
  test("reads a written reference", () => {
    expect(ModelV2.parseRef("anthropic/claude-haiku-4-5")).toEqual({
      providerID: ProviderV2.ID.make("anthropic"),
      modelID: ModelV2.ID.make("claude-haiku-4-5"),
    })
  })

  test("splits a written variant off the model id", () => {
    expect(ModelV2.parseRef("anthropic/claude-haiku-4-5#thinking")).toEqual({
      providerID: ProviderV2.ID.make("anthropic"),
      modelID: ModelV2.ID.make("claude-haiku-4-5"),
      variant: ModelV2.VariantID.make("thinking"),
    })
  })

  test("keeps a model id that itself contains slashes", () => {
    expect(ModelV2.parseRef("openrouter/openai/gpt-5#high")).toEqual({
      providerID: ProviderV2.ID.make("openrouter"),
      modelID: ModelV2.ID.make("openai/gpt-5"),
      variant: ModelV2.VariantID.make("high"),
    })
  })

  test("rejects a reference that names no provider or no variant", () => {
    // `parse` would read these as a provider with an empty model id, or as a model id carrying the
    // suffix, and then look up a model that cannot exist.
    expect(ModelV2.parseRef("claude-haiku-4-5")).toBeUndefined()
    expect(ModelV2.parseRef("anthropic/")).toBeUndefined()
    expect(ModelV2.parseRef("anthropic/claude-haiku-4-5#")).toBeUndefined()
  })
})
