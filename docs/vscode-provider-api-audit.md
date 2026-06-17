# VS Code Language Model Chat Provider API Audit

Date: 2026-06-17
Source: [VS Code Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
Extension version: 0.0.21

## Executive Summary

The NanoGPT extension implements the VS Code `LanguageModelChatProvider` contract comprehensively. The three required methods (`provideLanguageModelChatInformation`, `provideLanguageModelChatResponse`, `provideTokenCount`) are all implemented. All documented response part types (`LanguageModelTextPart`, `LanguageModelToolCallPart`, `LanguageModelThinkingPart`) are emitted. All documented input part types (`LanguageModelTextPart`, `LanguageModelDataPart`, `LanguageModelToolCallPart`, `LanguageModelToolResultPart`, `LanguageModelPromptTsxPart`) are converted. The extension handles `silent` mode, per-model `configuration`, `managementCommand`, and the `onDidChangeLanguageModelChatInformation` event.

Remaining gaps are minor: token counting uses a heuristic rather than model-specific tokenizers, the `toolCalling` capability only supports boolean (not the `number` alternative), and `LanguageModelToolResultPart` is not emitted as a *response* part (it is only consumed as *input*).

---

## 1. Registration & Lifecycle

| API Feature | Status | Notes |
| --- | --- | --- |
| `package.json` `contributes.languageModelChatProviders` | ✅ Done | Vendor `"nanogpt"`, displayName `"NanoGPT"` |
| `managementCommand` | ✅ Done | `"nanogpt.manage"` — prompts for API key |
| `configuration` JSON schema (provider-level) | ✅ Done | `apiKey` (secret), `routingMode`, `provider`, `reasoningEffort`, `reasoningOutput`, `toolCallingStrategy` |
| `lm.registerLanguageModelChatProvider()` | ✅ Done | Guarded behind feature detection for older VS Code builds |
| `onDidChangeLanguageModelChatInformation` event | ✅ Done | Fires on cache clear, configuration changes |
| Activation event | ✅ Done | `onStartupFinished` |

---

## 2. Language Model Information (`provideLanguageModelChatInformation`)

| `LanguageModelChatInformation` field | Status | Notes |
| --- | --- | --- |
| `id` | ✅ Done | Mapped from NanoGPT `id` / `canonicalId` |
| `name` | ✅ Done | Mapped from `displayName` / `name` |
| `family` | ✅ Done | Mapped from `family` |
| `version` | ✅ Done | Mapped from `version` |
| `maxInputTokens` | ✅ Done | Mapped from `context_length` / `contextWindow` |
| `maxOutputTokens` | ✅ Done | Mapped from `max_output_tokens` / `maxTokens` |
| `tooltip` (optional) | ✅ Done | Model ID + family description |
| `detail` (optional) | ✅ Done | Detailed description string |
| `capabilities.imageInput` | ✅ Done | Mapped from `capabilities.vision` |
| `capabilities.toolCalling` (boolean) | ✅ Done | Mapped from `capabilities.tool_calling` |
| `capabilities.toolCalling` (number) | ❌ Not implemented | VS Code docs state this can be `boolean \| number` for parallel call limits. Extension only maps to boolean |
| `configurationSchema` (optional) | ✅ Done | Per-model schema built dynamically via `buildModelConfigurationSchema()` for API key, routing, provider, reasoning effort/output |

### Discovery behavior

| Feature | Status | Notes |
| --- | --- | --- |
| Silent mode (no UI prompts) | ✅ Done | Returns `[]` or `DEFAULT_MODELS` without prompting |
| Non-silent mode (can prompt) | ✅ Done | Shows "Manage API Key" warning when key is missing |
| `configuration` parameter | ✅ Done | Reads per-model provider configuration overrides |
| Cache (in-memory + persisted) | ✅ Done | LRU-style per `apiKey + routingMode + allowlist`, persisted to `globalState` |
| Fallback on discovery failure | ✅ Done | Falls back to cache, then `DEFAULT_MODELS` |
| Allowlist filtering | ✅ Done | Filters discovered models to configured allowlist |
| Family-based cache tokens | ✅ Done | Derives family tokens from allowlist for cache key |
| Fresh-install onboarding | ✅ Done | Opens API key flow on first silent discovery without configuration |

---

## 3. Chat Response (`provideLanguageModelChatResponse`)

### Options & parameters

| Feature | Status | Notes |
| --- | --- | --- |
| `model: LanguageModelChatInformation` | ✅ Done | Uses `model.id`, `model.maxInputTokens`, `model.internal?.parallelToolCalls` |
| `messages: LanguageModelChatRequestMessage[]` | ✅ Done | Converted via `toCoreMessages` → `toNanoGptMessages` |
| `options.modelOptions.maxTokens` | ✅ Done | Forwarded as `max_tokens` |
| `options.configuration` | ✅ Done | Resolves API key, routing, provider, reasoning, tool-calling strategy per-model |
| `options.tools` | ✅ Done | Converted to OpenAI-compatible function tools |
| `options.toolMode` | ✅ Done | Maps `Required` → `"required"`, `Auto` → `"auto"`, omitted → default |
| `progress: Progress<LanguageModelResponsePart>` | ✅ Done | Streams text, reasoning, tool calls |
| `token: CancellationToken` | ✅ Done | Bridged to `AbortSignal` for fetch |

### Response parts emitted

| Part Type | Status | Notes |
| --- | --- | --- |
| `LanguageModelTextPart` | ✅ Done | Text deltas streamed as they arrive |
| `LanguageModelToolCallPart` | ✅ Done | Tool calls from native SSE or bridge JSON |
| `LanguageModelThinkingPart` | ✅ Done | Reasoning deltas when VS Code build supports it; falls back to `LanguageModelTextPart` when `reasoningOutput` is `"visible"` |
| `LanguageModelToolResultPart` (response) | ❌ Not emitted | Not needed for chat — only used as *input* to models. VS Code docs list it as a response part type but the extension never emits tool results as responses |

### Error handling

| Feature | Status | Notes |
| --- | --- | --- |
| `LanguageModelError.NotFound` for missing key | ✅ Done | Thrown when API key is not configured |
| Error propagation | ✅ Done | HTTP errors and stream errors thrown as `Error` |
| Abnormal `finish_reason` warnings | ✅ Done | `"length"` and `"content_filter"` surfaced as user-visible text |
| Malformed tool-call API rejection | ✅ Done | Detected via `isMalformedToolCallError()` and retried with bridge mode |
| Retry loop (network/idle timeout) | ✅ Done | Up to 2 retries with exponential backoff |
| Stream idle timeout | ✅ Done | 60s per-chunk timeout |

### Input message part conversion

| Part Type | Status | Notes |
| --- | --- | --- |
| `LanguageModelTextPart` | ✅ Done | Extracted as `{ value }` |
| `LanguageModelDataPart` | ✅ Done | Extracted as `{ data, mimeType }`; large images (>10 MiB) dropped with warning |
| `LanguageModelToolCallPart` | ✅ Done | Extracted as `{ callId, name, input }` |
| `LanguageModelToolResultPart` | ✅ Done | Extracted with nested content part conversion |
| `LanguageModelPromptTsxPart` | ✅ Partial | Extracted via feature detection; only string values handled |
| `unknown` part type | ✅ Done | Falls through to `{}` (ignored) |
| `message.name` | ❌ Not used | The `name` field on messages is ignored during conversion |

---

## 4. Token Counting (`provideTokenCount`)

| Feature | Status | Notes |
| --- | --- | --- |
| String input | ✅ Done | Returns `estimateTokenCount(text)` |
| `LanguageModelChatRequestMessage` input | ✅ Done | Returns `estimateTokenCount(toCoreMessages([text])[0])` |
| Model-specific tokenizer | ❌ Not implemented | Uses a character-count heuristic (chars ÷ 4). NanoGPT provides `tokenizer` capability hints (`cl100k_base`, `o200k_base`) that could drive `tiktoken` selection |
| CancellationToken | ✅ Done | Accepted but not needed (synchronous estimation) |

---

## 5. Configuration & Settings

| Feature | Status | Notes |
| --- | --- | --- |
| Provider-level `configuration` schema (package.json) | ✅ Done | Full JSON schema with enums, defaults, descriptions |
| Per-model `configurationSchema` | ✅ Done | Built dynamically per model via `buildModelConfigurationSchema()` |
| `apiKey` as VS Code secret | ✅ Done | Stored via `context.secrets`, not workspace settings |
| `reasoningEffort` enum | ✅ Done | `auto`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh` — all 7 values |
| `reasoningOutput` enum | ✅ Done | `native`, `hidden`, `visible` |
| `toolCallingStrategy` enum | ✅ Done | `native`, `auto`, `bridge` |
| `routingMode` enum | ✅ Done | `subscription`, `paygo` |
| `provider` free-form string | ✅ Done | Sent as `X-Provider` header in paygo mode |
| Invalid-value warnings (deduplicated) | ✅ Done | `reasoningEffort`, `reasoningOutput`, `toolCallingStrategy` all get `warnOnceInvalidConfig` |
| Persisted warning dedup | ✅ Done | Via `workspaceState` |
| `Reset Saved Configuration` command | ✅ Done | Clears secrets, settings, cache |
| `Refresh Models` command | ✅ Done | Clears cache, triggers re-discovery |

---

## 6. Commands

| Command | Status | Notes |
| --- | --- | --- |
| `nanogpt.manage` | ✅ Done | API key input box → secret storage |
| `nanogpt.refreshModels` | ✅ Done | Clears model cache |
| `nanogpt.resetConfiguration` | ✅ Done | Full reset with confirmation dialog |
| `nanogpt.openWalkthrough` | ✅ Done | Opens the VS Code walkthrough |

---

## 7. Gaps Summary

| # | Gap | Severity | Recommendation |
| --- | --- | --- | --- |
| 1 | `capabilities.toolCalling` only supports boolean, not `number` | Low | Map `parallel_tool_calls` to `toolCalling: number` if the model supports it |
| 2 | `provideTokenCount` uses character heuristic, not model tokenizer | Low | Could use `tiktoken` with the `tokenizer` capability hint (`cl100k_base` / `o200k_base`) for more accurate counts |
| 3 | `LanguageModelToolResultPart` not emitted as response part | Info | Not needed — VS Code docs list it but providers don't typically emit tool results as responses |
| 4 | `LanguageModelPromptTsxPart` partial support | Low | Only string values extracted; array values joined; non-string values ignored |
| 5 | `message.name` field not forwarded | Low | The `name` field on `LanguageModelChatRequestMessage` is ignored during conversion. Could be used for participant attribution |
| 6 | `maxInputTokens` mapping uses raw `context_length` | Info | VS Code docs example subtracts `maxOutput` from `contextWindow`. Extension uses `context_length` directly, which is correct for NanoGPT models that report `max_input_tokens` separately |

---

## 8. Extension-Specific Additions (Beyond VS Code API)

The extension implements several features beyond the minimum VS Code API contract:

| Feature | Description |
| --- | --- |
| Tool-calling bridge mode | Text-based JSON contract for models that struggle with native tool calls |
| Auto bridge retry | Detects empty/scaffolding native turns and retries with bridge mode |
| Malformed tool-call fallback | Detects API-level tool-call validation errors and retries with bridge |
| Streaming retry loop | Exponential backoff retry for transient failures, idle timeouts, 0-part responses |
| Context truncation | Pre-flight token budget validation with `truncateMessagesForContext()` |
| Finish reason warnings | User-visible warnings for `length` (truncation) and `content_filter` (refusal) |
| Model cache persistence | Last-known-good model list survives cold starts |
| Family-based cache tokens | Cache entries shared across model size variants |
| Fresh-install onboarding | Auto-opens API key flow on first launch |
| Reset configuration | Full cleanup command for all extension state |
