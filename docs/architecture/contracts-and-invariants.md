# Contracts and Invariants

This document lists the important implementation rules that future changes should preserve unless the architecture is intentionally changed.

## 1. File Ownership Boundaries

### VS Code Integration Layer (`src/extension.ts`, `src/config.ts`, `src/logging.ts`, `src/vscode-messaging.ts`)

`src/extension.ts` must remain the only layer that directly depends on VS Code runtime APIs for provider lifecycle. Config/messaging/logging modules also depend on VS Code but are separated by concern.

Expected responsibilities:

- provider registration (`extension.ts`)
- command registration (`extension.ts`)
- secret storage access (`config.ts`)
- workspace configuration access (`config.ts`)
- output channel creation (`logging.ts`)
- VS Code request/response part adaptation (`vscode-messaging.ts`)

### Transport Layer (`src/client.ts`, `src/client-stream.ts`, `src/client-bridge.ts`)

Must remain free of VS Code imports.

Expected responsibilities:

- HTTP requests
- timeout/cancellation composition (via `utils.ts`)
- **retry logic with exponential backoff** for transient failures (network errors, idle timeouts, 0-part responses)
- **per-chunk idle timeout** (60s default) to detect stalled streams
- SSE stream reading with **finish_reason tracking** and abnormal-value warnings
- low-level sanitized transport logging

### Core Transformation Layer (`src/nanogpt.ts`, `src/nanogpt-types.ts`, `src/nanogpt-message.ts`, `src/nanogpt-tool-bridge.ts`, `src/bridge-types.ts`, `src/bridge-message-builder.ts`, `src/bridge-payload-parser.ts`, `src/bridge-xml-parser.ts`, `src/bridge-json-parser.ts`, `src/nanogpt-request.ts`, `src/nanogpt-parser.ts`, `src/default-models.ts`)

Must remain free of VS Code imports and network I/O.

Expected responsibilities:

- pure types (`nanogpt-types.ts`)
- request builders (`nanogpt-request.ts`)
- message transforms (`nanogpt-message.ts`)
- tool-calling bridge transforms (`nanogpt-tool-bridge.ts`, `bridge-types.ts`, `bridge-message-builder.ts`, `bridge-payload-parser.ts`, `bridge-xml-parser.ts`, `bridge-json-parser.ts`)
- model mapping (`nanogpt.ts`)
- schema builders (`nanogpt.ts`)
- SSE parsing helpers (`nanogpt-parser.ts`)
- default model catalogue (`default-models.ts`)

### Shared Utilities (`src/utils.ts`)

Must remain free of VS Code imports. Contains cross-cutting helpers used by both transport and core layers.

## 2. ESM and Import Contract

The project is ESM and uses `moduleResolution: "NodeNext"`.

Invariant:

- local imports in `src/` must use `.js` extensions

Examples:

- `./client.js`
- `./nanogpt.js`

## 3. Schema Coupling Contract

The provider configuration schema is declared in two places:

1. programmatically in `buildModelConfigurationSchema()`
2. statically in `package.json` under `contributes.languageModelChatProviders[0].configuration`

Invariant:

- any property added, removed, or renamed in one place must be reflected in the other

Current schema fields:

- `apiKey`
- `routingMode`
- `provider`
- `reasoningEffort`
- `reasoningOutput`
- `toolCallingStrategy`

Related workspace settings in `package.json`:

- `nanogpt.apiKey`
- `nanogpt.routingMode`
- `nanogpt.provider`
- `nanogpt.models`
- `nanogpt.reasoningEffort`
- `nanogpt.reasoningOutput`
- `nanogpt.toolCallingStrategy`
- `nanogpt.verboseLogging`

## 4. API Key Handling Contract

The extension must never log secrets.

Invariant:

- API keys may be read from several sources, but must not be emitted to logs, docs, errors, or telemetry-like output

Current precedence:

1. provider config
2. secret storage

Legacy opt-in fallback path (only when `{ allowInsecureSources: true }` is explicitly enabled):

- workspace settings (`nanogpt.apiKey`)
- environment variable (`NANOGPT_API_KEY`)

Preferred user path:

- provider configuration flow or `NanoGPT: Manage API Key`

## 5. Logging Privacy Contract

The `NanoGPT` output channel is intentionally sanitized.

Must not log:

- raw prompts
- assistant text output bodies in full
- full request JSON
- tool arguments
- tool results
- API keys

May log:

- model ids
- routing modes
- provider ids
- tool names
- counts and durations
- error messages already surfaced by the transport layer

## 6. Routing Contract

There are exactly two supported routing modes today:


Endpoint mapping:

- `subscription` -> `/api/subscription/v1`
`reasoningEffort: "auto"` is not sent to NanoGPT.

Invariant:

- `auto` is a local sentinel meaning omit the field

Supported transmitted effort values:
- `high`

- `xhigh`

When a configured value is non-empty, not `"auto"`, and not one of the six valid levels, the extension logs a one-time deduplicated warning per invalid value (keyed on the provider instance lifetime) and falls back to the model default by omitting `reasoning_effort` from the request.

Current response-field compatibility:

- `reasoning`
- `reasoning_content`
- `thinking`

Current output-shaping behavior:

- `hidden` omits the request-side `reasoning` field and suppresses streamed reasoning in the UI
- `native` requests non-excluded reasoning and prefers `LanguageModelThinkingPart`
- `visible` also requests non-excluded reasoning but falls back to plain text if native thinking parts are unavailable

## 8. Tool-Calling Contract

Tool calling currently follows OpenAI-compatible chat completion semantics.

Invariants:

- `Required` tool mode maps to `tool_choice: "required"`
- default/auto behavior is represented by omission
- tool schema payload larger than 200 KB throws before the request is sent
- malformed streamed tool arguments degrade to `{}` rather than crash the stream
- `toolCallingStrategy` is extension-local and accepts `native | auto | bridge`
- `toolCallingStrategy` defaults to `native` when omitted or invalid; `auto` and `bridge` are explicit opt-in alternatives
- `native` and `auto` with tools both buffer the native turn through a unified `shouldBufferNativeTurn` path and suppress thin scaffolding preambles (e.g. "Let me gather related files..") when the stream also contains tool calls, to avoid triggering VS Code's Copilot Chat loop-detection guard on BYOK streams
- `auto` additionally retries at most once via the bridge path when a tool-enabled native turn yields no tool calls and either no visible text or only low-signal scaffolding text
- `bridge` rewrites tool history into plain messages plus a strict JSON-only system contract, and preserves `toolMode: "required"` through prompt instructions rather than native `tool_choice`
- malformed bridged replies get one JSON-only repair retry before the client decides whether to parse tool calls, accept a final bridged answer, or fall back
- bridged-turn reasoning deltas are buffered per-turn (via `reasoningChunks` on `BridgeTurnResult`) and only emitted on the final committed bridge turn; reasoning from a discarded repair-retry turn does not leak to the caller
- when a bridged model reply still contains visible prose but omits the required JSON object after the repair retry, the client surfaces an explicit raw-text fallback warning only for non-required tool turns
- when `toolMode: "required"` is active and the bridged model reply still does not contain any usable tool calls after the repair retry, the client returns a required-turn warning signal/string and the provider emits the warning `LanguageModelTextPart` instead of surfacing raw prose
- pending streamed tool calls are flushed at EOF via `flushPendingToolCalls()` so providers that omit `[DONE]` do not silently lose tool calls

`parallel_tool_calls` is represented internally on discovered models but not surfaced as a VS Code-visible capability.

## 9. Message Translation Contract

Important behaviors preserved by tests:

- numeric role `0` maps to `system`
- text-only messages collapse to string content
- image data becomes `image_url` data URLs
- tool result messages become `role: "tool"`
- mixed user text + tool results preserve the text as a separate message before tool results

Future changes should preserve these semantics unless NanoGPT or VS Code contracts force a different representation.

## 10. Cache Contract

Model cache key (via `createModelCacheKey` in `src/extension.ts`):

- `${routingMode}:${sha256Hex(apiKey)}`
- When an allowlist is active: `${key}:${normalizedAllowlist}`
  where `normalizedAllowlist` is the allowlist IDs sorted and joined by `,`.

Implications:

- API keys are hashed before use so raw credentials are never in memory keys
- different API keys do not share cached discovery results
- subscription and paygo do not share discovery results
- allowlist variations produce distinct cache entries so one allowlist cannot fall back to another's results
- clearing cache flushes all keys and routing modes
- clearing cache must also fire the provider-level model-change event so VS Code knows to rediscover models

Cache lookup is consulted **before** calling `discoverModels`. A populated in-memory entry (whether populated by a previous successful discovery in the same session or hydrated from `context.globalState` on activation) short-circuits the network call and is returned immediately. A discovery failure still falls back to the same cache so a transient outage cannot leave the model picker empty.

### Persisted model cache (cross-session)

The in-memory model cache is mirrored to `context.globalState` under key `nanogpt.modelCache` (versioned schema `version: 1`) so cold starts with a flaky network still surface a last-known-good model list. Hydration happens in the constructor; persistence happens after each successful discovery; `clearModelCache` also writes `undefined` to the same key.

Persisted cache contract:

- schema is `{ version: 1, entries: Record<cacheKey, VscodeModelMetadata[]> }`
- mismatched or malformed `version` values cause the persisted copy to be ignored
- entries with non-array values are skipped defensively
- persisted cache failures (read or write) are logged at warn level and never thrown into the discovery path
- configuration changes to `nanogpt.apiKey`, `nanogpt.routingMode`, or `nanogpt.models` clear both the in-memory and persisted caches

### Persisted warning dedup sets (cross-reload)

Invalid-value warning dedup sets (`warnedInvalidReasoningEfforts`, `warnedInvalidReasoningOutputs`, `warnedInvalidToolCallingStrategies`) are persisted to `context.workspaceState` so that a user who reloads the extension window is not re-warned for the same configuration typo. Hydration happens in `hydrateWarnedSets()` during construction; persistence is fire-and-forget via `persistWarnedSet()` when a new invalid value is encountered.

Persisted warning contract:

- keys: `nanogpt.warnedInvalidReasoningEfforts`, `nanogpt.warnedInvalidReasoningOutputs`, `nanogpt.warnedInvalidToolCallingStrategies`
- values: `string[]` (the deduplicated set of invalid configured values encountered)
- read failures are silently ignored and the in-memory Set is simply empty
- write failures are silently caught and ignored (the warning has already been logged to the output channel)
- the Sets are never cleared by the provider — they accumulate over the extension lifetime and across reloads; users who fix the typo will simply never see the warning again

## 11. Testing Contract

Current automated test split:

- `test/client.test.ts` for transport/client behavior
- `test/nanogpt.test.ts` for pure-core behavior

Invariant:

- tests run in plain Node with Vitest and should not import `vscode`

That means extension-host-specific behavior must be verified manually unless a separate integration strategy is introduced.

## 12. Packaging Contract

The extension packages as a VSIX and excludes development-only material via `.vscodeignore`.

Current notable manifest/runtime decisions:

- `extensionKind: ["ui"]`
- untrusted workspaces unsupported
- `vscode:prepublish` builds the extension
- output lives in `dist/`

## 13. Change Checklist

When changing this repository, verify all relevant items below.

- If you add or change provider config fields, update:
  - `src/nanogpt.ts` (type + schema)
  - `src/config.ts` (validator — note: `getReasoningEffort` delegates to `getReasoningEffortWithStatus`, `getReasoningOutput` delegates to `getReasoningOutputWithStatus`, `getToolCallingStrategy` delegates to `getToolCallingStrategyWithStatus`; all three `*WithStatus` variants return `{ value, invalidValue? }` for invalid-value tracking and warning deduplication)
  - `package.json` (contribution schema)
  - tests
- If you change tool-calling strategy or bridge behavior, update:
  - `src/client.ts`
  - `src/nanogpt-tool-bridge.ts`
  - tool-calling tests and architecture docs
- If you change routing behavior, update:
  - `src/extension.ts`
  - `src/client.ts`
  - `src/nanogpt-request.ts`
  - README/docs
- If you change message translation, update:
  - `src/vscode-messaging.ts`
  - `src/nanogpt-message.ts`
  - tests covering history and tool/result flows
- If you change logging behavior, re-check sanitization invariants.
- If you change client transport logic, rerun stream/cancellation tests.
- If you change the architecture split, update this documentation set.
