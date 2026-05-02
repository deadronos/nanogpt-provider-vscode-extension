# Architecture Documentation

This folder documents the current implementation of the NanoGPT VS Code provider as it exists in this repository today.

## Document Map

| Document | Purpose |
| --- | --- |
| [current-architecture.md](current-architecture.md) | Top-level system architecture, runtime boundaries, module ownership, and extension lifecycle. |
| [runtime-flows.md](runtime-flows.md) | Step-by-step runtime flows for activation, model discovery, chat streaming, tool calls, reasoning, logging, and token counting. |
| [contracts-and-invariants.md](contracts-and-invariants.md) | Implementation contracts, invariants, schema coupling, security rules, and change checklist for future work. |

## Architecture Summary

The extension is intentionally split into three implementation layers:

1. `src/extension.ts`
   Owns VS Code API integration, provider registration, configuration resolution, secret handling, request logging, and runtime orchestration.
2. `src/client.ts`
   Owns NanoGPT HTTP I/O, request execution, timeouts, SSE streaming, and transport-level logging hooks. It does not import VS Code.
3. `src/nanogpt.ts`
   Owns pure types, request builders, message transforms, schema generation, SSE parsing helpers, and model metadata mapping. It does not import VS Code.

That separation is not incidental. It is a core design constraint of the repository and is enforced by test structure and project guidance.

## Primary Source Files

| File | Role |
| --- | --- |
| `package.json` | Declares the extension manifest, commands, provider contribution schema, workspace settings, runtime capabilities, and build/test scripts. |
| `src/extension.ts` | Registers the provider, resolves config and secrets, creates the `NanoGPT` output channel, and bridges VS Code request/response types to the client/core layers. |
| `src/client.ts` | Executes `GET /models` and `POST /chat/completions`, manages timeouts and cancellation, and streams SSE responses into typed callbacks. |
| `src/nanogpt.ts` | Provides the pure request/message/schema/model mapping utilities used by both the client and tests. |
| `test/client.test.ts` | Covers HTTP client behavior, error handling, stream parsing, reader release, and sanitized logging. |
| `test/nanogpt.test.ts` | Covers request building, message conversion, SSE parsing helpers, schema coupling, and model metadata mapping. |

## Current Scope

Implemented today:

- VS Code Language Model Chat Provider registration under vendor `nanogpt`.
- Provider-scoped and workspace-scoped configuration for routing, provider, reasoning, and optional model allowlists.
- API key resolution from provider config, secret storage, settings, and environment fallback.
- NanoGPT model discovery for `subscription` and `paygo` routing modes.
- Streaming chat completions with text, reasoning, and tool call support.
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
