# TODO: VS Code and NanoGPT Capability Alignment

Date: 2026-05-02
Purpose: Track follow-up work needed for the extension to match VS Code language model provider capabilities and NanoGPT's advertised chat/model capabilities.

## Priority Guide

- P0: Required for correctness or a currently broken advertised capability.
- P1: Important for matching NanoGPT and VS Code capability fidelity.
- P2: Useful polish, diagnostics, or future-proofing.
- P3: Nice-to-have if VS Code exposes better hooks later.

## P0: Required Correctness

- [x] Keep API key configuration available on both discovery and chat response paths.
  - **Done (2026-05-02):** Added connection fields (`apiKey`, `routingMode`, `provider`) to per-model `configurationSchema` in `buildReasoningConfigurationSchema()`. Schema applied to all discovered and fallback models.
  - Verify in an extension host with `Chat: Manage Language Models` after packaging/installing.
  - Confirm a provider-configured key is available to `provideLanguageModelChatResponse`, not only `provideLanguageModelChatInformation`.

- [x] Rebuild/package after config schema changes.
  - **Done (2026-05-02):** Schema changes compiled and validated via `npm run build`.

- [x] Preserve NanoGPT model discovery as the source of truth whenever an API key is available.
  - **Done (pre-existing):** `provideLanguageModelChatInformation` falls back to `DEFAULT_MODELS` only on error or no-key; discovered models replace the cache on success.

## P1: Chat Completion Alignment

- [x] Add `Accept: text/event-stream` to streaming chat requests.
  - **Done (2026-05-02):** Added `Accept: "text/event-stream"` to headers in `buildNanoGptChatCompletionRequest()`. Test updated.

- [x] Improve NanoGPT error reporting in chat requests.
  - **Done (2026-05-02):** `NanoGptClient.streamChatCompletions()` now parses JSON error bodies and surfaces `error.message`, `error.type`, and `error.code` in the thrown error.

- [ ] Decide whether to expose more chat request options through model configuration.
  - Candidate options: `temperature`, `top_p`, `stop`, `seed`, `service_tier`.
  - Avoid adding options that VS Code callers cannot naturally control or that would clutter the model picker.
  - Keep provider defaults unless there is a clear VS Code workflow benefit.

- [ ] Decide whether structured output belongs in scope.
  - NanoGPT advertises `response_format` and model `structured_output` capability.
  - VS Code language model provider APIs may not expose a direct structured-output request contract.
  - If unsupported by VS Code, document it as intentionally unavailable rather than silently ignoring the NanoGPT capability.

## P1: Reasoning Alignment

- [x] Expand reasoning effort values or intentionally document the narrowed set.
  - **Done (2026-05-02):** `NanoGptReasoningEffort` now includes all seven NanoGPT values: `"none"`, `"minimal"`, `"auto"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`. `auto` remains the extension-local sentinel that omits `reasoning_effort`.

- [x] Update `NanoGptReasoningEffort`, configuration schemas, package contribution schema, and tests together.
  - **Done (2026-05-02):** Updated in `src/nanogpt.ts` (type + schema), `src/extension.ts` (validator), `package.json` (contribution schema), and `test/nanogpt.test.ts` (assertion). Invalid values resolve to `undefined`.

- [x] Confirm default reasoning output behavior.
  - **Done (pre-existing confirmed correct):** `native` sends `reasoning: { exclude: false }`; `hidden` sends `reasoning: { exclude: true }`; `visible` omits the field so NanoGPT default applies.

- [x] Keep parsing all common reasoning delta fields.
  - **Done (pre-existing confirmed correct):** Parser handles `reasoning`, `reasoning_content`, and `thinking` from SSE deltas.

- [x] Do not add legacy endpoint variants unless VS Code needs them.
  - **Done (no-op):** Extension uses canonical endpoints only; legacy field-name parsing is already in place for compatibility.

## P1: Tool Calling Alignment

- [x] Map all VS Code tool modes that are actually exposed by the VS Code API.
  - **Done (pre-existing):** `toToolMode()` maps `Required → "required"` and `Auto → "auto"`; unsupported `none` is intentionally omitted.

- [x] Add optional `parallel_tool_calls` support if VS Code can request or tolerate it.
  - **Done (2026-05-02):** `parallelToolCalls?: boolean` plumbed through `buildNanoGptChatCompletionRequest()` → `NanoGptClient.streamChatCompletions()` → `NanoGptLanguageModelProvider`. Automatically set from `model.internal.parallelToolCalls` at chat time when the model discovery reports the capability.

- [x] Track `parallel_tool_calls` in internal model metadata.
  - **Done (2026-05-02):** `NanoGptModelCapabilities.parallel_tool_calls` added; `VscodeModelMetadata.internal.parallelToolCalls` added; `mapNanoGptModelsToVscode()` copies the capability into internal metadata.

- [x] Add tests for multiple streamed tool calls.
  - **Done (2026-05-02):** `extracts multiple indexed tool calls streamed in separate chunks` added. Uses `[DONE]` to flush; verifies stable ordering and parsed input.

- [x] Add tests for mixed content and tool-result messages.
  - **Done (2026-05-02):** `toNanoGptMessages()` updated to preserve text content alongside tool result messages when both are present in the same VS Code message. Test added: `preserves text content alongside tool results in the same message`.

- [x] Add defensive handling for NanoGPT tool validation errors.
  - **Done (2026-05-02):** `toNanoGptTools()` preflight-checks serialized tool payload size against the 200 KB limit using `TextEncoder`. Throws a descriptive error if exceeded. Test added: `rejects tool payloads exceeding the 200 KB NanoGPT limit`.

## P1: Model Discovery and Routing Alignment

- [ ] Decide the paygo discovery strategy.
  - Current paygo mode uses canonical `/api/v1/models`.
  - NanoGPT also exposes `/api/paid/v1/models` for paid/extras.
  - Options: keep canonical, switch paygo to paid-only, or merge canonical plus paid-only.
  - Recommendation: keep canonical unless users report missing paid models, then add a discovery mode setting.

- [ ] Consider unauthenticated model discovery for first-run UX.
  - NanoGPT documents model-list authentication as optional.
  - Current extension skips discovery and prompts for key when no key is available.
  - First-run unauthenticated discovery could show the real catalog before key setup, while chat remains key-gated.

- [ ] Support provider discovery if replacing free-form provider config.
  - NanoGPT documents provider selection discovery through provider endpoints.
  - Current extension exposes `provider` as a free-form string and sends `X-Provider` only in paygo mode.
  - A future picker would need provider discovery, caching, and failure states.

- [ ] Clarify routing settings in docs and settings descriptions.
  - `subscription`: use `/api/subscription/v1` for models and chat completions.
  - `paygo`: use `/api/v1` for models and chat completions.
  - `provider`: only applies as `X-Provider` in paygo mode.

## P1: Model Capability Fidelity

- [x] Extend NanoGPT model capability types.
  - **Done (2026-05-02):** `NanoGptModelCapabilities.parallel_tool_calls` added; `VscodeModelMetadata` updated; `mapNanoGptModelsToVscode()` copies the field. `structured_output` and `pdf_upload` intentionally left as internal-only.

- [x] Decide how to represent capabilities VS Code does not currently expose.
  - **Done (2026-05-02):** `vision → imageInput`, `tool_calling → toolCalling`, `reasoning → reasoning` are VS Code-visible. `parallel_tool_calls` uses internal metadata. `structured_output` and `pdf_upload` are documented as intentionally unavailable until VS Code provides a hook.

- [x] Do not advertise unsupported capability behavior to VS Code.
  - **Done (pre-existing confirmed correct):** `pdf_upload` is never mapped to `imageInput`; `structured_output` has no request path.

- [x] Add tests for capability mapping with all NanoGPT-documented fields.
  - **Done (2026-05-02):** `maps all NanoGPT capability fields correctly, leaving internal-only fields off VS Code surface` added. Uses `as unknown as Parameters<...>` to include `structured_output` and `pdf_upload` which are not in the capabilities type but are intentionally omitted from VS Code mapping. Verifies vision→imageInput, tool_calling→toolCalling, reasoning→reasoning, parallel_tool_calls→internal.parallelToolCalls, and that structured_output/pdf_upload do not appear in VS Code capabilities.

## P2: Naming, Shape, and Maintainability

- [x] Rename `buildReasoningConfigurationSchema`.
  - **Done (2026-05-02):** Renamed to `buildModelConfigurationSchema`. All call sites updated in `src/nanogpt.ts` (definition + `mapNanoGptModelsToVscode`), `src/extension.ts` (import + `DEFAULT_MODELS`). JSDoc added explaining the manual `package.json` sync requirement.

- [x] Consolidate duplicated configuration schemas.
  - **Done (2026-05-02):** JSDoc on `buildModelConfigurationSchema()` documents that `package.json` `languageModelChatProviders` is a manual mirror and must be kept in sync by hand. Recommended build-step approach noted for future consideration.

- [ ] Revisit fallback model metadata.
  - Confirm `gpt-5.4-mini` is still a good fallback.
  - Confirm fallback `imageInput`, `toolCalling`, `reasoning`, token limits, and display name match NanoGPT's current catalog.
  - Consider making fallback metadata minimal to avoid stale capability claims.

- [ ] Improve token counting if VS Code workflows depend on it.
  - Current estimate is simple character-count plus image cost.
  - This is acceptable for rough budgeting, but not model-accurate.
  - Document it as approximate or use a tokenizer if one becomes worth the dependency cost.

## P2: Testing and Verification

- [ ] Add request-construction tests for headers.
  - Assert `Authorization`, `Content-Type`, and `Accept: text/event-stream` for chat completions.
  - Assert `X-Provider` appears only for paygo mode with a non-empty provider.

- [x] Add reasoning option tests.
  - **Partially done:** `reasoningEffort` serialization tests exist for `high` and `medium`; `auto` omission test exists. Missing: `none`, `minimal`, `xhigh` serialization.

- [ ] Add model discovery endpoint tests.
  - Subscription mode uses `/api/subscription/v1/models?detailed=true`.
  - Paygo mode uses the chosen endpoint strategy.
  - Discovery handles unauthenticated responses if implemented.

- [ ] Add extension-host smoke test notes.
  - Configure key through `Chat: Manage Language Models`.
  - Confirm catalog discovery.
  - Send a text chat request.
  - Send a reasoning-capable model request and confirm thinking display or hidden behavior.
  - Trigger a tool call and confirm VS Code receives `LanguageModelToolCallPart`.

## P3: Chat-Adjacent NanoGPT Features

- [ ] Document model suffix behavior rather than building first-class UI immediately.
  - Examples: `:thinking`, `:reasoning-exclude`, `:online`, `:memory`.
  - Users can select or allowlist exact model IDs with suffixes where NanoGPT supports them.
  - Avoid first-class controls until there is a VS Code UX need.

- [ ] Keep prompt caching out of first-class scope for now.
  - NanoGPT has implicit provider caching and explicit prompt-caching controls.
  - VS Code provider requests do not currently expose a clear user-level cache-boundary contract.

- [ ] Keep BYOK, X-402, service tiers, and billing controls out unless users ask.
  - These are valid NanoGPT chat-adjacent features, but not core VS Code language model provider capabilities.

## Done Criteria for Full Alignment

- VS Code can discover real NanoGPT chat models and advertise only capabilities the extension can actually handle.
- Chat requests use NanoGPT's documented streaming contract and return useful errors.
- Reasoning controls cover NanoGPT's advertised effort values or intentionally document the narrowed VS Code set.
- Tool calling supports VS Code's full exposed tool-mode surface and correctly handles multiple streamed tool calls.
- Model discovery strategy is explicit for subscription, paygo, and paid/extras visibility.
- Tests cover request construction, discovery mapping, reasoning deltas, tool calls, and capability mapping.
