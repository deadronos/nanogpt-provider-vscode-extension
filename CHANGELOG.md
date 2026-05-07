# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

## 0.0.8

- Fixed mixed tool result + image message loss: multimodal user turns now preserve images alongside text when tool results are present in the same message.
- Enforced hidden reasoning locally: when `reasoningOutput` is `"hidden"`, streamed reasoning deltas are no longer surfaced as thinking parts or text fallbacks.
- Fixed token counting for tool results: nested tool-result text and binary payloads now contribute to approximate token estimates.
- Scoped model discovery cache more precisely by including a normalized allowlist component in cache keys.
- Added regression tests covering mixed message conversion, tool-result token estimation, and discovery allowlist scenarios.
- Replaced `Buffer.from` with `TextDecoder` in the core layer (`nanogpt.ts`, `nanogpt-message.ts`) and rewrote `toBase64` in `utils.ts` with a portable loop + `btoa` implementation so the core modules no longer depend on Node.js-specific APIs.

## 0.0.7

- Added verbose runtime-model diagnostics that log how VS Code resolves NanoGPT models and token counting after provider registration, to debug Copilot tokenizer failures.
- Fixed streamed tool-call name handling so later SSE name chunks replace earlier fragments instead of being concatenated into invalid tool names.
- Cancelled response readers during chat-stream teardown and added regression coverage for reader cleanup.
- Hashed API keys before using them in model-discovery cache keys and tightened internal typing for tool serialization and runtime capability inspection.

## 0.0.6

- Added Copilot-compatible hidden tokenizer hints to discovered NanoGPT model metadata so coding-agent tools can budget prompts for provider-backed models.
- Stopped advertising all NanoGPT-discovered models as the synthetic `nanogpt`/`nano-gpt` family-version pair; model metadata now prefers upstream `family`/`version` when available and otherwise falls back to the model id, including allowlist fallback stubs.
- Centralised `SECRET_KEY`, `VERBOSE_LOGGING_SETTING`, and `isVerboseLoggingEnabled` in `config.ts`; removed duplicated declarations from `extension.ts`.
- Eliminated double `getProvider()` call in chat response handler.
- Fixed `isObject` type guard to exclude arrays, preventing tool-call arguments parsed as JSON arrays from being used as raw objects.
- Updated `withTimeout` test to use fake timers for deterministic execution.

## 0.0.5

- Refactored monolithic `src/extension.ts` (803 lines) and `src/nanogpt.ts` (790 lines) into focused, single-responsibility modules.
- New modules extracted from `src/nanogpt.ts`: `nanogpt-types.ts`, `nanogpt-message.ts`, `nanogpt-request.ts`, `nanogpt-parser.ts`.
- New modules extracted from `src/extension.ts`: `config.ts`, `logging.ts`, `vscode-messaging.ts`.
- New shared `src/utils.ts` for cross-cutting helpers (abort/timeout, formatting, type guards).
- `src/nanogpt.ts` now serves as a barrel re-export module plus model mapping/schema/token logic.
- Tests split into matching test files: `nanogpt.test.ts`, `nanogpt-message.test.ts`, `nanogpt-request.test.ts`, `nanogpt-parser.test.ts`, `utils.test.ts`.
- Updated all architecture docs and AGENTS.md to reflect the new module structure.

## 0.0.4

- Fixed duplicate models appearing in the Configure Models section under the NanoGPT provider (Fixes #2).

## 0.0.3

- Fixed VS Code system-role mapping for numeric role enums.
- Released streaming readers cleanly and removed the dependency on `AbortSignal.timeout()`.
- Added explicit Prompt TSX handling, packaging exclusions, and extension manifest metadata.

## 0.0.2

- Added NanoGPT language model provider support for VS Code.
