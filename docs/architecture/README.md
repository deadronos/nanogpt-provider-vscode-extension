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
   Owns NanoGPT HTTP I/O, request execution, timeouts, SSE streaming, and transport-level logging hooks. It does not import VS Code.
3. **Core transformation layer** (`src/nanogpt.ts`, `src/nanogpt-types.ts`, `src/nanogpt-message.ts`, `src/nanogpt-tool-bridge.ts`, `src/nanogpt-request.ts`, `src/nanogpt-parser.ts`)
   Owns pure types, request builders, message transforms, tool-calling bridge transforms, schema generation, SSE parsing helpers, and model metadata mapping. None of the core modules import VS Code.

That separation is not incidental. It is a core design constraint of the repository and is enforced by test structure and project guidance.

## Primary Source Files

| File | Role |
| --- | --- |
| `package.json` | Declares the extension manifest, commands, provider contribution schema, workspace settings, runtime capabilities, and build/test scripts. |
| `src/extension.ts` | Provider class, activation, commands, abort-signal bridging. |
| `src/config.ts` | Configuration resolution: API key, routing, provider, models, reasoning, logging. |
| `src/logging.ts` | `NanoGPT` output channel and logger construction. |
| `src/vscode-messaging.ts` | VS Code message-part compatibility (`toCoreMessages`, `toToolMode`, `createThinkingPart`). |
| `src/client.ts` | Executes `GET /models` and `POST /chat/completions`, manages timeouts and cancellation, and streams SSE responses into typed callbacks. |
| `src/utils.ts` | Shared cross-cutting helpers: abort/timeout composition, formatting, type guards. |
| `src/nanogpt-types.ts` | API constants and all type definitions (`NanoGptChatMessage`, `VscodeModelMetadata`, etc.). |
| `src/nanogpt-message.ts` | Message/part conversion and tool serialization (`toNanoGptMessages`, `toNanoGptTools`). |
| `src/nanogpt-tool-bridge.ts` | Strict JSON bridge prompt builder plus bridge-history and bridge-response transforms for reliable tool calling. |
| `src/nanogpt-request.ts` | Request body/header builder (`buildNanoGptChatCompletionRequest`). |
| `src/nanogpt-parser.ts` | SSE parser and collectors (`NanoGptSseParser`, `collectSseResponseParts`). |
| `src/nanogpt.ts` | Barrel re-exports, `mapNanoGptModelsToVscode`, `buildModelConfigurationSchema`, `estimateTokenCount`. |
| `test/client.test.ts` | Covers HTTP client behavior, error handling, stream parsing, reader release, and sanitized logging. |
| `test/nanogpt.test.ts` | Covers model mapping, schema coupling, and token estimation. |
| `test/nanogpt-message.test.ts` | Covers message conversion and tool serialization. |
| `test/nanogpt-request.test.ts` | Covers request building edge cases. |
| `test/nanogpt-parser.test.ts` | Covers SSE parser and tool-call deltas. |
| `test/utils.test.ts` | Covers shared utility functions. |

## Current Scope

Implemented today:

- VS Code Language Model Chat Provider registration under vendor `nanogpt`.
- Provider-scoped and workspace-scoped configuration for routing, provider, reasoning, tool-calling strategy, and optional model allowlists.
- API key resolution from provider config, secret storage, settings, and environment fallback.
- NanoGPT model discovery for `subscription` and `paygo` routing modes.
- Streaming chat completions with text, reasoning, and tool call support, including `native`, `auto`, and `bridge` tool-calling strategies. `auto` is the default.
- In `auto` mode, native tool turns are buffered so the client can retry once through the bridge path when a model emits no tool calls and only low-signal scaffolding text.
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
