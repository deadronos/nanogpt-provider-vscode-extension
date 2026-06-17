# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### 0.0.21

- Extracted `src/bridge-xml-parser.ts` (XML-like tool-call extraction) and `src/bridge-json-parser.ts` (JSON extraction, bridge turn normalization, tool-call container parsing) from `src/bridge-payload-parser.ts`. The original module is now a thin entry point that imports from both sub-parsers and runs the normalization chain.
- Extracted `src/client-stream.ts` (`executeStreamingRequest`, `emitParts`, SSE pipeline) and `src/client-bridge.ts` (`streamCompletionsViaBridge`, `executeBridgeTurn`, scaffolding detection, bridge telemetry helpers) from `src/client.ts`. The HTTP client now delegates to these standalone modules.
- Extracted `warnOnceInvalidConfig()` to `src/provider-state.ts` and replaced three near-identical invalid-value warning blocks in `src/extension.ts` with calls to the shared helper.
- Added shared `StreamRequestCore` and `StreamCallbacks` types in `src/client.ts` to eliminate copy-pasted parameter declarations across the streaming, bridge, and native completion methods.
- Unified `processStreamParts`/`emitParts` in `src/client.ts` — `processStreamParts` now delegates to `emitParts` instead of duplicating the iteration and type-switch logic.
- Tightened `NanoGptChatStreamResult` so `bridgeTelemetry` and `summary` are always fully populated by the client, removing the defensive spread that was previously required in the caller.
- Extended the invalid-value `*WithStatus` pattern from `reasoningEffort` to `reasoningOutput` and `toolCallingStrategy` so configuration typos in those fields also surface a one-time deduplicated warning in the output log instead of silently falling back to their defaults.
- Persisted the `warnedInvalidReasoningEfforts`, `warnedInvalidReasoningOutputs`, and `warnedInvalidToolCallingStrategies` dedup sets to `vscode.ExtensionContext.workspaceState` so users who reload the extension window are not warned again for the same configuration typo.
- Added an optional logger parameter to `prepareChatRequest()` so oversized inline image drops (>10 MiB) emit a single warning with the count, total bytes, and message role instead of silently discarding parts.
- Added `parseProviderConfiguration()` — a runtime type-narrower that validates the shape of the raw provider configuration payload at the boundary and returns a typed `ProviderConfiguration` or `undefined` on structural mismatch.
- Fixed the language-model provider configuration schema to remove unsupported enum-label metadata from the manifest and runtime configuration schema, which resolves the VS Code strict-schema validation warning that was blocking provider registration.
- Unified the native-turn buffering strategy so `native` and `auto` tool-calling modes share the same buffer path. The previous separate `deferredTextParts`/`bufferedNativeParts` paths were mutually exclusive by design but difficult to scan — they now flow through a single `shouldBufferNativeTurn` guard with a shared `emitParts` helper.
- Wired bridge-turn stream part counts (`summary`) through `NanoGptChatStreamResult` so bridge and retry turns surface the same per-turn telemetry fidelity as native turns in the output log.
- Buffered bridge-turn reasoning until the final committed turn instead of streaming reasoning live on every attempt. This prevents reasoning from a discarded repair-retry turn from leaking to the user when `reasoningOutput` is `native` or `visible`.
- Surfaced a one-time deduplicated warning in the output log when `reasoningEffort` is configured to a non-empty, non-`auto` value that is not one of the six valid NanoGPT effort levels (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`).
- Changed the missing-API-key error to use `LanguageModelError.NotFound()` so consumers can distinguish a credential failure from a generic transport error via the error `code` property.
- Clarified the scaffolding-suppression heuristic, the year-strip risk in the family-token regex, and the capability-pessimistic fallback catalogue in doc comments and the walkthrough guide.- Added a retry loop with exponential backoff (max 2 retries) around native streaming calls so transient network errors, idle timeouts, and 0-part responses are retried transparently instead of surfacing as "model just stopped." Non-retryable errors (auth failures, 4xx) and already-aborted signals are not retried.
- Added a per-chunk idle timeout (60s default) to the SSE stream reader so hung connections that stop sending data without closing are detected and aborted instead of silently waiting for the 5-minute global timeout.
- Added `finish_reason` tracking to the SSE parser. Abnormal finish reasons (`"length"` for truncation, `"content_filter"` for refusal) are now logged as warnings and exposed in `StreamProcessingSummary.finishReason` so callers can distinguish normal completions from truncated or refused responses.

## 0.0.20

- Refreshed the extension dev-tooling stack to the currently published versions available from npm, including newer `@types/node`, `vitest`, and `@vitest/coverage-v8` updates while keeping the VS Code API typings and packaging tooling aligned with the current published release line.

## 0.0.19

- Tightened the API key resolution chain: `resolveApiKey` now consults only per-model provider configuration and VS Code secret storage by default. The legacy workspace-setting (`nanogpt.apiKey`) and environment-variable (`NANOGPT_API_KEY`) fallbacks are gated behind an explicit `{ allowInsecureSources: true }` opt-in to prevent accidental credential exposure through synced settings or child-process inheritance. The `nanogpt.apiKey` workspace setting is deprecated with migration guidance.
- Added a 5-step `Walkthroughs` contribution (`NanoGPT for VS Code`) for first-run onboarding, covering API key setup, model picker, per-model settings, chat verification, and reset.
- Broadened the `DEFAULT_MODELS` fallback catalogue from 1 model to 5 (`gpt-5.4-mini`, `gpt-5.4`, `claude-sonnet-4.5`, `gemini-2.5-pro`, `deepseek-r1`) so the model picker is not empty during unconfigured discovery. All entries use pessimistic capability stubs since real capabilities come from the NanoGPT discovery API.
- Added a family dimension to the discovery cache key: `deriveFamilyTokensFromAllowlist()` strips size/quantisation suffixes (`-mini`, `-pro`, `-32k`, etc.) from allowlisted model ids so related models collapse to the same family token and different families get independent cache entries.
- Added `prepareChatRequest()` in `src/nanogpt-request.ts` — an internal request-preparation hook that strips oversized base64 inline images (>10 MiB) and drops empty assistant turns before serialisation. Wired into both the native and bridge stream paths in `NanoGptClient`. Designed as the extension-local equivalent of the `prepareLanguageModelChat` hook that newer VS Code APIs may expose on `LanguageModelChatInformation` in the future.

## 0.0.18

- Fixed fresh-install onboarding in newer VS Code Insiders builds: the NanoGPT provider no longer declares `apiKey` as a required language-model provider field, and unconfigured non-silent discovery now returns fallback models plus missing-key onboarding instead of an empty model list. This restores the `Add Models > NanoGPT` flow when no provider instance exists yet.
- Changed silent discovery for the unconfigured NanoGPT provider to open the existing API-key entry flow instead of staying fully passive. This lets `Add Models > NanoGPT` prompt for a key on first run while keeping configured silent discovery non-interactive.
- Added `NanoGPT: Reset Saved Configuration` so users can clear extension-owned NanoGPT state without reinstalling VS Code or the extension. The command deletes the saved API key, removes `nanogpt.*` settings at all VS Code scopes, clears the persisted model cache, and then offers direct follow-up actions for `Manage API Key` or `Add Models`.

## 0.0.17

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
