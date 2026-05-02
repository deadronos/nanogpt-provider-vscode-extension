# Contracts and Invariants

This document lists the important implementation rules that future changes should preserve unless the architecture is intentionally changed.

## 1. File Ownership Boundaries

### `src/extension.ts`

Must remain the only layer that directly depends on VS Code runtime APIs.

Expected responsibilities:

- provider registration
- command registration
- secret storage access
- workspace configuration access
- output channel creation
- VS Code request/response part adaptation

### `src/client.ts`

Must remain free of VS Code imports.

Expected responsibilities:

- HTTP requests
- timeout/cancellation composition
- SSE stream reading
- low-level sanitized transport logging

### `src/nanogpt.ts`

Must remain free of VS Code imports and network I/O.

Expected responsibilities:

- pure types
- request builders
- message transforms
- model mapping
- schema builders
- SSE parsing helpers

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

Related workspace settings in `package.json`:

- `nanogpt.apiKey`
- `nanogpt.routingMode`
- `nanogpt.provider`
- `nanogpt.models`
- `nanogpt.reasoningEffort`
- `nanogpt.reasoningOutput`
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

- `hidden` excludes reasoning
- `native` requests non-excluded reasoning and prefers `LanguageModelThinkingPart`
- `visible` also requests non-excluded reasoning but falls back to plain text if native thinking parts are unavailable

## 8. Tool-Calling Contract

Tool calling currently follows OpenAI-compatible chat completion semantics.

Invariants:

- `Required` tool mode maps to `tool_choice: "required"`
- default/auto behavior is represented by omission
- tool schema payload larger than 200 KB throws before the request is sent
- malformed streamed tool arguments degrade to `{}` rather than crash the stream

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

Model cache key:

- `${apiKey}|${routingMode}`

Implications:

- different API keys do not share cached discovery results
- subscription and paygo do not share discovery results
- clearing cache flushes all keys and routing modes

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
  - `src/nanogpt.ts`
  - `package.json`
  - tests in `test/nanogpt.test.ts`
- If you change routing behavior, update:
  - `src/extension.ts`
  - `src/client.ts`
  - `src/nanogpt.ts`
  - README/docs
- If you change message translation, update:
  - `src/extension.ts`
  - `src/nanogpt.ts`
  - tests covering history and tool/result flows
- If you change logging behavior, re-check sanitization invariants.
- If you change client transport logic, rerun stream/cancellation tests.
- If you change the architecture split, update this documentation set.
