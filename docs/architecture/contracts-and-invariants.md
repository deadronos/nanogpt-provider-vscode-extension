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

### Transport Layer (`src/client.ts`)

Must remain free of VS Code imports.

Expected responsibilities:

- HTTP requests
- timeout/cancellation composition (via `utils.ts`)
- SSE stream reading
- low-level sanitized transport logging

### Core Transformation Layer (`src/nanogpt.ts`, `src/nanogpt-types.ts`, `src/nanogpt-message.ts`, `src/nanogpt-tool-bridge.ts`, `src/nanogpt-request.ts`, `src/nanogpt-parser.ts`)

Must remain free of VS Code imports and network I/O.

Expected responsibilities:

- pure types (`nanogpt-types.ts`)
- request builders (`nanogpt-request.ts`)
- message transforms (`nanogpt-message.ts`)
- tool-calling bridge transforms (`nanogpt-tool-bridge.ts`)
- model mapping (`nanogpt.ts`)
- schema builders (`nanogpt.ts`)
- SSE parsing helpers (`nanogpt-parser.ts`)

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
3. settings
4. environment variable

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

- `subscription`
- `paygo`

Endpoint mapping:

- `subscription` -> `/api/subscription/v1`
- `paygo` -> `/api/v1`

`X-Provider` is only sent for `paygo` and only when `provider.trim()` is non-empty.

## 7. Reasoning Contract

`reasoningEffort: "auto"` is not sent to NanoGPT.

Invariant:

- `auto` is a local sentinel meaning omit the field

Supported transmitted effort values:

- `none`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

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
- `auto` retries at most once, and only when a tool-enabled native turn yields no tool calls and either no visible text or only low-signal scaffolding text
- `bridge` rewrites tool history into plain messages plus a strict JSON-only system contract, and preserves `toolMode: "required"` through prompt instructions rather than native `tool_choice`
- malformed bridged replies get one JSON-only repair retry before the client decides whether to parse tool calls, accept a final bridged answer, or fall back
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
  - `src/config.ts` (validator)
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
