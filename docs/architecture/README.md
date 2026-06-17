# Architecture Documentation

This folder documents the current implementation of the NanoGPT VS Code provider as it exists in this repository today.

## Document Map

| Document | Purpose |
| --- | --- |
| [current-architecture.md](current-architecture.md) | Top-level system architecture, runtime boundaries, module ownership, and extension lifecycle. |
| [runtime-flows.md](runtime-flows.md) | Step-by-step runtime flows for activation, model discovery, chat streaming, tool calls, reasoning, logging, and token counting. |
| [contracts-and-invariants.md](contracts-and-invariants.md) | Implementation contracts, invariants, schema coupling, security rules, and change checklist for future work. |

## Architecture Summary

The extension is intentionally split into three implementation layers, with sub-modules for finer responsibility isolation:

1. **VS Code integration layer** (`src/extension.ts`, `src/config.ts`, `src/logging.ts`, `src/vscode-messaging.ts`)
   Owns VS Code API integration, provider registration, configuration resolution, secret handling, request logging, and runtime orchestration.
2. **Transport layer** (`src/client.ts`)
   Owns NanoGPT HTTP I/O, request execution, timeouts, SSE streaming, and transport-level logging hooks. Split across `src/client.ts` (orchestration), `src/client-stream.ts` (SSE pipeline), and `src/client-bridge.ts` (bridge mode). Does not import VS Code.
3. **Core transformation layer** (`src/nanogpt.ts`, `src/nanogpt-types.ts`, `src/nanogpt-message.ts`, `src/nanogpt-tool-bridge.ts`, `src/nanogpt-request.ts`, `src/nanogpt-parser.ts`)
   Owns pure types, request builders, message transforms, tool-calling bridge transforms (split across `src/bridge-types.ts`, `src/bridge-message-builder.ts`, `src/bridge-payload-parser.ts`, `src/bridge-xml-parser.ts`, `src/bridge-json-parser.ts`), schema generation, SSE parsing helpers, and model metadata mapping. None of the core modules import VS Code.

That separation is not incidental. It is a core design constraint of the repository and is enforced by test structure and project guidance.

## Primary Source Files

| File | Role |
| --- | --- |
| `package.json` | Declares the extension manifest, commands, provider contribution schema, workspace settings, runtime capabilities, and build/test scripts. |
| `src/extension.ts` | Provider class, activation, commands, abort-signal bridging. |
| `src/config.ts` | Configuration resolution: API key, routing, provider, models, reasoning, logging. |
| `src/logging.ts` | `NanoGPT` output channel and logger construction. |
| `src/vscode-messaging.ts` | VS Code message-part compatibility (`toCoreMessages`, `toToolMode`, `createThinkingPart`). |
| `src/client.ts` | Executes `GET /models` and `POST /chat/completions` with retry logic (exponential backoff for transient failures, idle timeouts, 0-part responses), manages timeouts and cancellation, tracks `finish_reason`, and streams SSE responses into typed callbacks. |
| `src/client-stream.ts` | Core SSE streaming execution (`executeStreamingRequest`, `emitParts`) shared by native and bridge paths. |
| `src/client-bridge.ts` | Bridge orchestration (`streamCompletionsViaBridge`, `executeBridgeTurn`), retry heuristics, and scaffolding detection. |
| `src/provider-cache.ts` | Model cache key creation, hydration, and persistence to `globalState`. |
| `src/provider-state.ts` | Warned-set hydration/persistence and the `warnOnceInvalidConfig` helper for deduplicated configuration warnings. |
| `src/provider-logging-helpers.ts` | Message, tool, and runtime-model summarization for sanitized logging. |
| `src/utils.ts` | Shared cross-cutting helpers: abort/timeout composition, formatting, type guards. |
| `src/nanogpt-types.ts` | API constants and all type definitions (`NanoGptChatMessage`, `VscodeModelMetadata`, etc.). |
| `src/nanogpt-message.ts` | Message/part conversion and tool serialization (`toNanoGptMessages`, `toNanoGptTools`). |
| `src/nanogpt-tool-bridge.ts` | Strict JSON bridge prompt builder plus bridge-history and bridge-response transforms for reliable tool calling. |
| `src/bridge-types.ts` | Shared types for the tool-calling bridge subsystem. |
| `src/bridge-message-builder.ts` | Bridge prompt construction (`buildToolCallingBridgeMessages`, `buildToolCallingBridgeRepairMessages`). |
| `src/bridge-payload-parser.ts` | Bridge response entry point (`parseToolCallingBridgeResponse`), delegates to XML and JSON sub-parsers. |
| `src/bridge-xml-parser.ts` | XML-like `<tool_calls>` block extraction for bridge responses. |
| `src/bridge-json-parser.ts` | JSON extraction, bridge turn normalization, tool-call container and argument parsing. |
| `src/nanogpt-request.ts` | Request body/header builder (`buildNanoGptChatCompletionRequest`). |
| `src/nanogpt-parser.ts` | SSE parser and collectors (`NanoGptSseParser`, `collectSseResponseParts`). |
| `src/nanogpt.ts` | Barrel re-exports, `mapNanoGptModelsToVscode`, `buildModelConfigurationSchema`, `estimateTokenCount`. |
| `src/default-models.ts` | Default model catalogue (5 models across families) surfaced when no API key or allowlist is configured. |
| `test/client.test.ts` | Covers HTTP client behavior, error handling, stream parsing, reader release, and sanitized logging. |
| `test/config.test.ts` | Covers configuration getters, API key precedence, model allowlist filtering, and reasoning/tool-calling validation. |
| `test/extension.test.ts` | Covers provider behavior in isolation, including allowlist stubs and persisted cache hydration. |
| `test/extension-compatibility.test.ts` | Covers runtime feature detection for the language model provider API and per-build fallback messages. |
| `test/extension-lifecycle.test.ts` | Covers activation, command registration, and configuration-change listeners. |
| `test/nanogpt.test.ts` | Covers model mapping, schema coupling, tokenizer heuristic, and token estimation. |
| `test/nanogpt-message.test.ts` | Covers message conversion and tool serialization (including mixed text + tool-result + image messages). |
| `test/nanogpt-request.test.ts` | Covers request body and header building edge cases. |
| `test/nanogpt-parser.test.ts` | Covers SSE parser, tool-call accumulation, reasoning-field detection, and EOF tool-call flushing. |
| `test/nanogpt-tool-bridge.test.ts` | Covers bridge prompt construction, bridge-response parsing (including JSON code fences and XML-like `<tool_calls>` payloads), and the JSON-only repair turn. |
| `test/utils.test.ts` | Covers shared utility functions. |
| `test/vscode-messaging.test.ts` | Covers VS Code message-part compatibility shims (`toCoreMessages`, `toToolMode`, `createThinkingPart`, `getPromptTsxText`). |

## Current Scope

Implemented today:

- VS Code Language Model Chat Provider registration under vendor `nanogpt`.
- Provider manifest integration through `languageModelChatProviders.managementCommand`, and missing-key onboarding that routes directly to the provider's own management command.
- Provider-scoped and workspace-scoped configuration for routing, provider, reasoning, tool-calling strategy, and optional model allowlists.
- API key resolution from provider config and secret storage by default; legacy settings/env fallbacks are opt-in only via `{ allowInsecureSources: true }`.
- NanoGPT model discovery for `subscription` and `paygo` routing modes.
- Silent model discovery returns no models and shows no UI when an API key is unavailable, matching VS Code's silent-resolution contract for BYOK providers.
- Streaming chat completions with text, reasoning, and tool call support, including `native`, `auto`, and `bridge` tool-calling strategies. `native` is the default again; `auto` and `bridge` are explicit opt-in modes.
- In `native` mode with tools, thin scaffolding text before tool calls is suppressed to avoid triggering VS Code's Copilot Chat loop-detection guard on BYOK streams.
- In `auto` mode, native tool turns are buffered so the client can retry once through the bridge path when a model emits no tool calls and either no visible text or only likely scaffolding text.
- Malformed bridge replies get one JSON-only repair retry before fallback handling, and when `toolMode: "required"` still omits usable tool calls the client returns `requiredToolWarning` and the provider emits it as a warning `LanguageModelTextPart` instead of surfacing raw prose.
- Vision/image input via `LanguageModelDataPart` image payload conversion.
- Approximate token counting for strings and request messages.
- Dedicated Output panel logging via the `NanoGPT` log channel.

Not implemented as first-class features:

- Anthropic-style `/messages` endpoint usage.
- Structured output request shaping.
- Non-image file upload for user messages.
- Provider discovery UI.
- Extension-host integration tests in the automated suite.

## Recommended Reading Order

1. [current-architecture.md](current-architecture.md)
2. [runtime-flows.md](runtime-flows.md)
3. [contracts-and-invariants.md](contracts-and-invariants.md)
