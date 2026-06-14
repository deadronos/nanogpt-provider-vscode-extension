# NanoGPT Provider for VS Code — Agent Instructions

Unofficial VS Code extension that registers NanoGPT as a VS Code Language Model Chat Provider, exposing NanoGPT models in the Copilot Chat model picker.

## Commands

```bash
npm run build       # Compile TypeScript → dist/
npm run typecheck   # Type-check without emitting
npm run test        # Run unit tests (vitest, no extension host)
npm run package     # Bundle .vsix via vsce
```

## Architecture

Source files organized into three layers with focused modules:

| File | Layer | Responsibility |
| --- | --- | --- |
| `src/extension.ts` | VS Code | Provider class, activation, commands, abort-signal bridging |
| `src/config.ts` | VS Code | Configuration resolution (API key, routing, models, reasoning) |
| `src/logging.ts` | VS Code | Output channel and logger creation |
| `src/vscode-messaging.ts` | VS Code | VS Code message-part compatibility (`toCoreMessages`, `toToolMode`, `createThinkingPart`) |
| `src/client.ts` | Transport | HTTP client: model discovery and streaming chat completions. No VS Code API. |
| `src/utils.ts` | Shared | Cross-cutting helpers (abort/timeout composition, formatting, type guards) |
| `src/nanogpt-types.ts` | Core | API constants, type definitions, `resolveRole`. No VS Code API, no I/O. |
| `src/nanogpt-message.ts` | Core | Message/part conversion, tool serialization. No VS Code API, no I/O. |
| `src/nanogpt-tool-bridge.ts` | Core | Tool-calling bridge prompt builder, history rewrite, and bridge-response normalization. No VS Code API, no I/O. |
| `src/nanogpt-request.ts` | Core | Request body/header builder, `prepareChatRequest()` normalisation hook. No VS Code API, no I/O. |
| `src/nanogpt-parser.ts` | Core | SSE parser and collectors. No VS Code API, no I/O. |
| `src/nanogpt.ts` | Core | Barrel re-exports, model mapping, schema builder, token estimation. No VS Code API, no I/O. |

Tests live in `test/` and run under Vitest in plain Node — no VS Code APIs are available there.

## Key Conventions

**ESM with `.js` import extensions** — `package.json` has `"type": "module"` and `tsconfig.json` uses `"moduleResolution": "NodeNext"`. All local imports in `src/` must use `.js` file extensions (e.g. `import ... from "./nanogpt.js"`).

**API key as VS Code secret** — The key is stored under secret key `"nanogpt.apiKey"` via `vscode.secrets`. Prefer the provider configuration flow (`Chat: Manage Language Models`) over workspace settings, which can be synced or committed.

**Two routing surfaces** — `subscription` maps to `NANOGPT_SUBSCRIPTION_BASE_URL`; `paygo` maps to `NANOGPT_BASE_URL`. Both are defined in `src/nanogpt.ts`.

**`reasoningEffort: "auto"` is an extension-local sentinel** — It means "omit the field", not "send `auto` to NanoGPT". The six actual values sent to the API are `none | minimal | low | medium | high | xhigh`.

**Coupled schema changes** — When modifying `NanoGptReasoningEffort`, `NanoGptToolCallingStrategy`, or adding config options, update all relevant locations together: `src/nanogpt-types.ts` (type), `src/nanogpt.ts` (schema), `src/config.ts` (validator), `package.json` (contribution schema), and tests.

**Tool-calling reliability strategies** — `toolCallingStrategy` is extension-local and supports `native | auto | bridge`. `auto` means native tools first, then a single bridge retry only when a tool-enabled native turn yields no visible text and no tool calls. `bridge` rewrites tool history into text plus a strict JSON contract using `src/nanogpt-tool-bridge.ts`.

**`buildModelConfigurationSchema()`** — Must be called per model in `DEFAULT_MODELS` and in model discovery results so VS Code exposes per-provider config fields at both discovery and chat-response time.

**Tests are pure unit tests** — They test `src/nanogpt.ts` and `src/client.ts` logic only. Do not import `vscode` in test files; the extension host is not available in vitest.

## Useful Docs

- [docs/todo.md](docs/todo.md) — Prioritised open work and completed items
- [docs/nanogpt-surface-audit.md](docs/nanogpt-surface-audit.md) — NanoGPT API capability coverage analysis
- [docs/extension-host-smoke-test.md](docs/extension-host-smoke-test.md) — Manual verification checklist for extension host testing

## Update Changelog

- Update CHANGELOG.md and propose to move "Unreleased" section to next semantic version bump.
- Add any relevant breaking change notes, new features, or bug fixes to the changelog entry.

## Architecture Docs

look at [docs/architecture/README.md](docs/architecture/README.md) for a detailed breakdown of the extension's architecture, design constraints, module responsibilities, and implementation contracts.

- Also align/update this architecture on any relevant changes not captured there yet.
