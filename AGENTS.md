- To regenerate the legacy JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Do not edit `src/generated` or `src/generated-effect` directly.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk-next` composes Client, Core, and Server.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@opencode-ai/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.

## V2 Session Core

- Keep durable prompt admission separate from model execution. `SessionV2.prompt(...)` admits one durable `session_input` row before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior. The serialized runner promotes admitted inputs into visible user messages at safe boundaries.
- Reusing a Session ID adopts the existing Session. Reusing a prompt message ID reconciles an exact retry only when Session, prompt, and delivery mode match; conflicting reuse fails. Historical projected prompts lazily synthesize promoted inbox records during exact retry.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID. V2 interruption targets the active process-local ownership chain for that Session; idle or missing interruption is a no-op.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per provider turn and reload projected history before durable continuation. Do not bridge through legacy `SessionPrompt.loop(...)` or delegate orchestration to an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently. Advisory wakes drain eligible durable inbox rows only; post-crash continuation recovery requires a separate explicit design before it may retry provider work. A drain has no durable identity or transcript boundary.
- Keep delivery vocabulary explicit. Prompts steer by default and promote at the next safe provider-turn boundary while the current drain requires continuation. An explicit `queue` input remains pending until the Session would otherwise become idle; promote one queued input at that boundary, then reevaluate continuation before promoting another. Promoting any new user input resets the selected agent's provider-turn allowance; a batch of steers resets it once.
- Keep EventV2 replay owner claims separate from clustered Session execution ownership.
- Keep the System Context algebra, registry, and built-ins in `src/system-context`; keep Context Source producers with their observed domains, and keep Session History selection plus Context Epoch persistence Session-owned.

## Agents, Models and Cost

- Run a step entirely on the model that answers it. Cost, the context window it is sized against, the history serialization and the tool definitions all follow the model the request goes to, not the one the session started on. This was got wrong twice, once per runtime.
- A variant belongs to the model it was chosen for. Names collide across a provider's models, so apply one only when the request goes to that model, and record on the message the variant the request actually carried. A variant the model does not declare as its own is not a variant.
- `budget` degrades, it does not stop: past it an agent keeps working on the small model and is told once. `budget_stop` is the ceiling, off unless asked for. A run meant to carry work to the end cannot depend on someone noticing that it halted.
- The two thresholds count different spans. The budget counts the session; the ceiling counts only the request being answered, so the next user message starts over with its tools — which is what the prompt shown at the ceiling already promises. Counted over the session the ceiling ends the session instead: spend never goes down, so every later request is answered by a summary that costs more than the last.
- A request ends where the person's next message begins, and only there. The runtime writes user messages of its own to keep one going — a compaction and its continuation, a background subagent's result delivered to its caller, a subtask command telling the agent to summarize and carry on — and a user message holding nothing the person wrote continues the request instead of starting one. Counted as requests of their own they hand the run a fresh ceiling allowance and its tools back with nobody present, so a long run buys another ceiling every time it compacts and an agent that delegated buys one every time something it started comes back. A message with no parts yet is nobody's: parts are written after the message, and a person's ask read in that window must not lose its own allowance to a race.
- The budget can ask instead of degrading, through the `budget` permission: `allow` degrades as before, `ask` asks once per request while past the budget, `deny` ends every request that goes past it. An authorized run keeps its model and tools — degrading a run somebody just paid to continue answers a question nobody asked — and a refused one ends in the same text-only summary turn as the ceiling, carrying the reason they gave.
- That gate reads the level, not the step that crossed: an agent past its budget is past it on every later step, and a gate that fires only on the crossing leaves `deny` more permissive than the `allow` it replaces. Only a rule naming `budget` decides it, never a ruleset's catch-all, which is about tools and which several built-in agents set to deny. And it never fires on a step that already ends the run, because a question a yes cannot change only makes a run configured to stop wait for somebody.
- A model resolved as "small" must still be able to call tools, and must differ from the session model in provider as well as id. The same id on another provider is a different route, different credentials and different billing.
- A subagent reported as done must say what it left running. Spawning with `background: true` detaches, and the detached task's answer goes to the subagent's own session, so a caller told only "completed" would act on a result that is missing a piece.

## Configuration Compatibility

- A setting written wrongly costs its own key, not the file. Both shapes are read as a whole first and group by group when that fails.
- Drop together the keys the migration folds into one setting. `tools` and `permission` become one ruleset, and keeping the half that allows while dropping the half that denies leaves a file more permissive than it reads; `share`/`autoshare` and `references`/`reference` are fallbacks with the same hazard.
- Judge a key both config shapes spell the same by the shape it positively has, never by "not the other one": values both shapes accept exist, and so do values neither fully describes.
- Say which file was ignored and why. A config that vanishes in silence is how three of these bugs stayed invisible.

## Testing the Session Loop

- Decisions about which model, variant, prompt or tool set a step gets are tested by driving the whole loop against the fake LLM server and asserting on the request that reached the wire. A unit test over the decision function cannot see a decision that is computed correctly and then not applied.
- Check a new test by breaking the code it covers and watching it fail. Every loop-level test here that matters was written against a bug it first reproduced.
