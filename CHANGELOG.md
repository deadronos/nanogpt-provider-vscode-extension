# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Persisted the discovery model cache to `context.globalState` under a versioned `nanogpt.modelCache` key so cold starts with a flaky network still surface a last-known-good model list. The provider hydrates the in-memory cache from `globalState` in the constructor and writes back after each successful discovery. `clearModelCache` also writes `undefined` to the same key so manual refreshes and configuration changes do not leave stale entries behind.
- Added a fast-path cache lookup before the network call: a populated in-memory entry (whether populated by a prior successful discovery in the same session or hydrated from `globalState` on activation) short-circuits `discoverModels` and is returned immediately. Discovery failures still fall back to the same cache as before.
- Improved the tokenizer heuristic in `mapNanoGptModelsToVscode`: added modern OpenAI families (`gpt-4o`, `gpt-4.1`, `gpt-4.5`, `gpt-5`, `gpt-oss`, the `o-series`) to an explicit `o200k_base` override so they are no longer misclassified as `cl100k_base`, and expanded the legacy `cl100k_base` pattern list with `text-embedding-ada-*` and `code-search-*`. Patterns are now organized as named constants for clarity, and the JSDoc explicitly notes the heuristic is informational for non-OpenAI models.
- Removed `nanogpt.provider` from the workspace configuration keys that invalidate the discovery cache. The discovery endpoint does not consume the provider field (it is only forwarded to chat-completion requests as the `X-Provider` header), so provider changes no longer trigger an unnecessary cache flush.
- Bumped `engines.vscode` to `^1.120.0` and `@types/vscode` to `^1.120.0` to track VS Code Insiders / latest stable. The `LanguageModelChatProvider`, `LanguageModelChatInformation`, `LanguageModelChatCapabilities`, `PrepareLanguageModelChatModelOptions`, and `lm.registerLanguageModelChatProvider` surface is unchanged from `1.118.0` (the only delta between 1.118.0 and 1.120.0 in `index.d.ts` is a tree-view JSDoc note); the bump is a maintenance alignment with no source changes required.

## 0.0.16

- Updated transitive dependencies in `package-lock.json` to resolve 3 npm audit vulnerabilities: `brace-expansion` 5.0.5 → 5.0.6 (DoS), `qs` 6.15.1 → 6.15.2 (DoS), `tmp` 0.2.5 → 0.2.6 (path traversal).
- Suppressed thin scaffolding preambles (e.g. "Let me gather related files..") before tool calls in native tool-calling mode so VS Code's Copilot Chat loop-detection guard does not misfire on BYOK provider streams.
- Fixed custom BYOK provider discovery to stay truly silent when credentials are missing: silent model resolution now returns no models and shows no warning UI instead of surfacing fallback entries that would fail at chat time.
- Added native provider management integration via the `languageModelChatProviders.managementCommand` contribution and simplified missing-key onboarding to route directly to `NanoGPT: Manage API Key`.
- Added regression coverage for silent discovery, manifest/provider schema coupling, VS Code message-part compatibility shims, and activation on builds that lack the chat-provider API.

## 0.0.15

- Clarified provider-supplied model tooltips to show separate input and output token limits for discovered NanoGPT models, reducing confusion when VS Code renders its own combined "max context" summaries elsewhere in the UI.
- Fixed incorrect maxInputTokens calculation that subtracted max_output_tokens from context_length.

## 0.0.14

- Changed missing-key onboarding behavior so non-silent discovery offers explicit actions `Open Manage Language Models` and `Manage API Key Directly`, while silent discovery shows only a single passive warning and does not open input dialogs or modals, including when discovery is returning allowlisted unverified model stubs without an API key.
- Fixed stale NanoGPT model lists in newer VS Code builds by emitting `onDidChangeLanguageModelChatInformation` whenever the extension clears its discovery cache, so saving an API key, running `NanoGPT: Refresh Models`, or changing model-affecting `nanogpt.*` settings prompts VS Code to rediscover models instead of requiring provider removal and re-add.
- Improved provider lifecycle diagnostics by tagging model-catalog invalidations with their trigger reason in the NanoGPT output log.

## 0.0.13

- Added tool definition token estimation: `estimateTokenCount()` now accepts an optional `tools` parameter and includes approximate tokens for tool names, descriptions, and input schemas in the result.
- Improved performance in bridge-mode tool-call history building by caching `tryParseJson` results instead of re-parsing tool arguments multiple times.
- Hardened `ProviderConfiguration` typing: field types are now more specific than `unknown` where appropriate, and `getModelAllowlist` filters out non-string entries from the `models` array.
- Corrected reasoning-effort documentation: the extension-local `auto` sentinel means six values are sent to the NanoGPT API, not seven (AGENTS.md).
- Added `.worktrees/` to `.gitignore`.

## 0.0.12

- Restored `native` as the default `toolCallingStrategy`; `auto` and `bridge` remain explicit opt-in reliability modes.
- Added a JSON-only repair retry for malformed bridge replies so prose-only bridge turns get one more chance to re-emit a valid tool-calling contract before fallback handling.
- Changed `toolMode: "required"` bridge behavior to fail closed with a provider-owned warning text part when the model still does not return any usable tool calls after the repair turn.

## 0.0.11

- Fixed bridge-mode replies that emit XML-like `<tool_calls>` markup instead of the JSON bridge contract by normalizing those pseudo tool tags back into executable tool calls instead of surfacing them as raw fallback text.
- Fixed prose-only bridge failures by surfacing an explicit raw-text fallback warning when a bridged model reply omits the required JSON object entirely, and tightened the bridge prompt so commentary instructions are redirected into the JSON `message` field.
- Changed the default `toolCallingStrategy` from `native` to `auto` so tool-enabled chats retry empty or scaffolding-only native turns through the bridge path without extra user configuration.
- Fixed `toolCallingStrategy: "auto"` so tool-enabled native turns are buffered long enough to detect low-signal scaffolding replies with no tool calls, then retried once through the bridge path.
- Preserved `toolMode: "required"` intent in bridge mode through stricter bridge-contract instructions, and stopped dropping flattened top-level `id`/`type` arguments when models omit an `arguments` object.
- Added regression coverage to ensure scaffolding-only native turns retry through the bridge while substantive native text answers still pass through unchanged.

## 0.0.10

- Added configurable tool-calling reliability strategies: `native`, `auto`, and `bridge`.
- Added a strict tool-calling bridge path that rewrites tool history into a JSON-only contract and parses bridged responses back into VS Code tool calls.
- Added a narrow automatic fallback: tool-enabled native turns that produce no visible text and no tool calls are retried once through the bridge path.
- Fixed streamed tool-call loss on EOF by flushing pending tool calls even when providers omit `[DONE]`.
- Added regression tests covering bridge parsing, bridge retries, direct bridge mode, and EOF tool-call flushing.
- **Known difference:** Bridge mode strips native `tools`, `tool_choice`, and `parallel_tool_calls` from the outbound request and uses a prompt-only contract for tool selection. Required tool mode is preserved through prompt instructions rather than native API enforcement.

## 0.0.9

- Fixed allowlist stub capabilities: unverified model stubs no longer clone `DEFAULT_MODELS[0]` capabilities. Instead they use safe pessimistic defaults (`imageInput: false`, `toolCalling: false`, `reasoning: false`) and are marked "NanoGPT (unverified)".
- Changed `reasoningOutput: "hidden"` to omit the `reasoning` field from the request body entirely, consistent with the `reasoningEffort: "auto"` sentinel pattern, rather than sending `{ exclude: true }`.
- Added `.editorconfig` for consistent formatting across contributors (LF, UTF-8, 2-space indent).
- Added implementation plan document at `docs/plans/improve-code-review-findings.md`.

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
