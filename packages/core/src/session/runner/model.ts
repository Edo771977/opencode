export * as SessionRunnerModel from "./model"

import { makeLocationNode } from "../../effect/app-node"
import { type Model } from "@opencode-ai/llm"
import * as AnthropicMessages from "@opencode-ai/llm/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "@opencode-ai/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@opencode-ai/llm/protocols/openai-responses"
import { Auth, type AnyRoute } from "@opencode-ai/llm/route"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
import { Catalog } from "../../catalog"
import { Config } from "../../config"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { SessionSchema } from "../schema"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
  },
) {
  override get message() {
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    variant: ModelV2.VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {
  override get message() {
    return `Unsupported API for ${this.providerID}/${this.modelID}: ${this.api}`
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedApiError
  | Integration.AuthorizationError

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<Model, Error>
  readonly resolveSmall: (session: SessionSchema.Info) => Effect.Effect<Model | undefined, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRunnerModel") {}

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (resolve: Interface["resolve"], resolveSmall?: Interface["resolveSmall"]) =>
  Layer.succeed(Service, Service.of({ resolve, resolveSmall: resolveSmall ?? (() => Effect.succeed(undefined)) }))

const apiKey = (model: ModelV2.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return Auth.value(credential.key)
  if (credential?.type === "oauth") return Auth.value(credential.access)
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return Auth.value(value)
}

const withDefaults = (model: ModelV2.Info, route: AnyRoute) => {
  const body = model.request.body
  const httpBody = Object.hasOwn(body, "apiKey")
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "apiKey"))
    : body
  return route.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: model.request.headers,
    http: { body: httpBody },
    limits: { context: model.limit.context, output: model.limit.output },
  })
}

const withVariant = (
  model: ModelV2.Info,
  variantID: ModelV2.VariantID | undefined,
): Effect.Effect<ModelV2.Info, VariantUnavailableError> => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant && variantID !== undefined && variantID !== "default")
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: variantID,
      }),
    )
  return Effect.succeed(
    variant
      ? produce(model, (draft) => {
          Object.assign(draft.request.headers, variant.headers)
          Object.assign(draft.request.body, variant.body)
        })
      : model,
  )
}

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

export const fromCatalogModel = (
  model: ModelV2.Info,
  credential?: Credential.Value,
): Effect.Effect<Model, UnsupportedApiError> => {
  const resolved =
    credential?.type !== "key" || credential.metadata === undefined
      ? model
      : produce(model, (draft) => {
          Object.assign(draft.request.body, credential.metadata)
        })
  const key = apiKey(resolved, credential)
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai") {
    return Effect.succeed(
      withDefaults(resolved, OpenAIResponses.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/anthropic") {
    return Effect.succeed(
      withDefaults(resolved, AnthropicMessages.route)
        .with({ auth: key === undefined ? Auth.none : Auth.header("x-api-key", key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai-compatible" && resolved.api.url) {
    return Effect.succeed(
      withDefaults(resolved, OpenAICompatibleChat.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  return Effect.fail(
    new UnsupportedApiError({
      providerID: resolved.providerID,
      modelID: resolved.id,
      api: apiName(resolved),
    }),
  )
}

export const resolve = (session: SessionSchema.Info, model: ModelV2.Info, credential?: Credential.Value) =>
  withVariant(model, session.model?.variant).pipe(Effect.flatMap((model) => fromCatalogModel(model, credential)))

export const supported = (model: ModelV2.Info) =>
  model.api.type === "aisdk" &&
  (model.api.package === "@ai-sdk/openai" ||
    model.api.package === "@ai-sdk/anthropic" ||
    (model.api.package === "@ai-sdk/openai-compatible" && model.api.url !== undefined))

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const config = yield* Config.Service
    // Location plugins populate and filter the catalog asynchronously during layer startup.
    const select = Effect.fn("SessionRunnerModel.select")(function* (session: SessionSchema.Info) {
      if (session.model)
        return (yield* catalog.model.available()).find(
          (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
        )
      const defaultModel = yield* catalog.model.default()
      if (defaultModel && supported(defaultModel)) return defaultModel
      return (yield* catalog.model.available()).find(supported)
    })
    // Resolution runs once per provider step, so a standing misconfiguration would otherwise repeat
    // its warning for every step of every turn. Each distinct reason is said once per location.
    const warned = new Set<string>()
    const warnOnce = Effect.fn("SessionRunnerModel.warnOnce")(function* (key: string, message: string) {
      if (warned.has(key)) return
      warned.add(key)
      yield* Effect.logWarning(message)
    })
    const configured = Effect.fn("SessionRunnerModel.configuredSmall")(function* () {
      const ref = Config.latest(yield* config.entries(), "small_model")
      if (ref === undefined) return undefined
      const parsed = ModelV2.parseRef(ref)
      if (!parsed) {
        yield* warnOnce(`malformed:${ref}`, `Configured small_model "${ref}" is not a provider/model reference`)
        return undefined
      }
      const found = (yield* catalog.model.available()).find(
        (model) => model.providerID === parsed.providerID && model.id === parsed.modelID,
      )
      // A reference that matches nothing is far more often a typo than a deliberate choice, and
      // falling back to the catalog's own pick would hide it.
      if (!found) yield* warnOnce(`missing:${ref}`, `Configured small_model "${ref}" is not in the catalog`)
      return found && { model: found, variant: parsed.variant }
    })
    const resolveSmallModel = Effect.fn("SessionRunnerModel.resolveSmall")(function* (session: SessionSchema.Info) {
      const selected = yield* select(session)
      if (!selected) return undefined
      // An explicitly configured `small_model` outranks the catalog's heuristic pick: the user named
      // a model, and silently running a different one is worse than not running a small model at all.
      const chosen: { model: ModelV2.Info | undefined; variant?: ModelV2.VariantID } = (yield* configured()) ?? {
        model: yield* catalog.model.small(selected.providerID),
      }
      const small = chosen.model
      if (!small) return undefined
      if (!supported(small) || !small.capabilities.tools) {
        yield* warnOnce(
          `unusable:${small.providerID}/${small.id}`,
          `Small model ${small.providerID}/${small.id} cannot serve an agent turn; using the session model instead`,
        )
        return undefined
      }
      // Compare the provider too: the same model id under another provider is a different route,
      // different credentials and different billing, and declining it would ignore the user's choice.
      if (small.id === selected.id && small.providerID === selected.providerID) return undefined
      const provider = yield* catalog.provider.get(small.providerID)
      const connection = yield* integrations.connection.active(
        provider?.integrationID ?? Integration.ID.make(small.providerID),
      )
      // `available()` already keeps unauthorized providers out of the catalog, so this only states
      // the invariant: never send a turn to another provider on an unauthenticated route.
      if (small.providerID !== selected.providerID && !connection) return undefined
      const credential = connection ? yield* integrations.connection.resolve(connection) : undefined
      // Never inherit a variant, and honor a written one where the model has it: the session's
      // variant is meaningless on a different model, while a variant written into `small_model`
      // names that exact pair. Passing undefined still applies the small model's own default
      // variant, which calling `fromCatalogModel` directly used to skip.
      //
      // A variant the model does not offer is a mistake in one word of the reference, and refusing
      // the small model over it would quietly stop an agent degrading and leave it paying full
      // price for the rest of the session. The model is used without it, said once.
      // `default` is not a variant of its own but the name for the model's own, which `withVariant`
      // resolves; anything else has to be in the model's list.
      const offered =
        chosen.variant === undefined ||
        chosen.variant === "default" ||
        small.variants.some((item) => item.id === chosen.variant)
      if (!offered)
        yield* warnOnce(
          `variant:${small.providerID}/${small.id}#${chosen.variant}`,
          `Small model ${small.providerID}/${small.id} does not offer the variant "${chosen.variant}"; using its own default instead`,
        )
      return yield* withVariant(small, offered ? chosen.variant : undefined).pipe(
        Effect.flatMap((model) => fromCatalogModel(model, credential)),
      )
    })
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        const selected = yield* select(session)
        if (!selected && session.model)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
        const provider = yield* catalog.provider.get(selected.providerID)
        const connection = yield* integrations.connection.active(
          provider?.integrationID ?? Integration.ID.make(selected.providerID),
        )
        return yield* resolve(
          session,
          selected,
          connection ? yield* integrations.connection.resolve(connection) : undefined,
        )
      }),
      // Opting an agent into the small model must never cost it a turn: an unavailable or
      // unauthorized small model degrades to the session model instead of failing. Interruption is
      // not a failure of the small model and must survive, so only non-interrupt causes are caught.
      resolveSmall: (session) =>
        resolveSmallModel(session).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning(`Could not resolve a small model; using the session model instead`, cause).pipe(
                Effect.as(undefined),
              ),
          ),
        ),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: locationLayer,
  deps: [Catalog.node, Integration.node, Config.node],
})
