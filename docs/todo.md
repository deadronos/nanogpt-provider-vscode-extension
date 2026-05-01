# TODO: VS Code and NanoGPT Capability Alignment

Date: 2026-05-02
Purpose: Track follow-up work needed for the extension to match VS Code language model provider capabilities and NanoGPT's advertised chat/model capabilities.

## Priority Guide

- P0: Required for correctness or a currently broken advertised capability.
- P1: Important for matching NanoGPT and VS Code capability fidelity.
- P2: Useful polish, diagnostics, or future-proofing.
- P3: Nice-to-have if VS Code exposes better hooks later.

## P0: Required Correctness

- [ ] Keep API key configuration available on both discovery and chat response paths.
  - Status: Implemented in the current working tree by adding connection fields to per-model configuration schemas.
  - Verify in an extension host with `Chat: Manage Language Models` after packaging/installing.
  - Confirm a provider-configured key is available to `provideLanguageModelChatResponse`, not only `provideLanguageModelChatInformation`.

- [ ] Rebuild/package after config schema changes.
  - Run `npm run build` before testing in VS Code.
  - Package with `npm run package` when producing a `.vsix`.
  - Confirm `dist/` reflects the source changes if the extension host runs compiled output.

- [ ] Preserve NanoGPT model discovery as the source of truth whenever an API key is available.
  - Ensure discovered `capabilities`, token limits, and names override fallback metadata.
  - Keep fallback model metadata clearly treated as a degraded/no-discovery path.

## P1: Chat Completion Alignment

- [ ] Add `Accept: text/event-stream` to streaming chat requests.
  - NanoGPT examples include this header for SSE streaming.
  - Current behavior may work through `stream: true`, but sending the header better matches the documented contract.
  - Add a request-building test that asserts the header is present.

- [ ] Improve NanoGPT error reporting in chat requests.
  - Parse JSON error bodies when available.
  - Surface NanoGPT `error.message`, `error.code`, `error.type`, and status code through `LanguageModelError` where appropriate.
  - Include request ID headers in diagnostics if NanoGPT returns one.

- [ ] Decide whether to expose more chat request options through model configuration.
  - Candidate options: `temperature`, `top_p`, `stop`, `seed`, `service_tier`.
  - Avoid adding options that VS Code callers cannot naturally control or that would clutter the model picker.
  - Keep provider defaults unless there is a clear VS Code workflow benefit.

- [ ] Decide whether structured output belongs in scope.
  - NanoGPT advertises `response_format` and model `structured_output` capability.
  - VS Code language model provider APIs may not expose a direct structured-output request contract.
  - If unsupported by VS Code, document it as intentionally unavailable rather than silently ignoring the NanoGPT capability.

## P1: Reasoning Alignment

- [ ] Expand reasoning effort values or intentionally document the narrowed set.
  - NanoGPT advertises `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
  - Current extension exposes `auto`, `low`, `medium`, and `high`.
  - Suggested schema: `auto`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
  - Preserve `auto` as the extension-local value that omits `reasoning_effort`.

- [ ] Update `NanoGptReasoningEffort`, configuration schemas, package contribution schema, and tests together.
  - Files likely involved: `src/nanogpt.ts`, `src/extension.ts`, `package.json`, `test/nanogpt.test.ts`, `README.md`.
  - Ensure invalid values still resolve to `undefined` or a safe default.

- [ ] Confirm default reasoning output behavior.
  - Current default `native` sends `reasoning: { exclude: false }`.
  - Decide whether native mode should explicitly request reasoning output or omit `reasoning` and let NanoGPT defaults apply.
  - Keep `hidden` mapped to `reasoning: { exclude: true }`.

- [ ] Keep parsing all common reasoning delta fields.
  - Already parses `reasoning`, `reasoning_content`, and `thinking`.
  - Add tests for interleaved reasoning and text deltas if not already covered.

- [ ] Do not add legacy endpoint variants unless VS Code needs them.
  - `v1legacy` and `v1thinking` are compatibility paths for clients that cannot read reasoning fields.
  - The extension already parses modern and legacy field names, so alternate base URLs should remain out unless a real VS Code issue appears.

## P1: Tool Calling Alignment

- [ ] Map all VS Code tool modes that are actually exposed by the VS Code API.
  - Current mapping supports `required` and treats auto/default as omission.
  - Check whether VS Code exposes a true `none` mode or specific-tool pinning for providers.
  - If available, map to NanoGPT `tool_choice: "none"` or object-form tool choice.

- [ ] Add optional `parallel_tool_calls` support if VS Code can request or tolerate it.
  - NanoGPT advertises both a request flag and a model capability.
  - Current parser can accumulate multiple indexed tool calls, but the request never asks for parallel calls.
  - If enabled globally, consider only sending it when model discovery reports `capabilities.parallel_tool_calls === true`.

- [ ] Track `parallel_tool_calls` in internal model metadata.
  - VS Code's current `capabilities` shape used here only includes `imageInput` and `toolCalling`.
  - If VS Code has no place for it, store it in an internal metadata field or leave it documented-only.
  - Add type coverage for `capabilities.parallel_tool_calls` in NanoGPT model entries.

- [ ] Add tests for multiple streamed tool calls.
  - Include two `delta.tool_calls` indices streaming in separate chunks.
  - Verify stable ordering by index.
  - Verify both calls flush once on `finish_reason: "tool_calls"` or `[DONE]`.

- [ ] Add tests for mixed content and tool-result messages.
  - Current conversion returns only tool result messages when any tool result is present in a VS Code message.
  - Confirm this matches VS Code's real message shape.
  - If VS Code can send mixed text plus tool result content in one message, preserve both without lossy conversion.

- [ ] Add defensive handling for NanoGPT tool validation errors.
  - NanoGPT documents invalid/oversized tool specs returning 400s such as `tool_spec_too_large`, `invalid_tool_spec`, or `invalid_tool_spec_parse`.
  - Optionally preflight serialized tool payload size near the documented 200 KB limit.

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

- [ ] Extend NanoGPT model capability types.
  - Add fields for `parallel_tool_calls`, `structured_output`, and `pdf_upload`.
  - Keep existing aliases for `vision`, `reasoning`, and `tool_calling`.

- [ ] Decide how to represent capabilities VS Code does not currently expose.
  - `vision` maps to `imageInput`.
  - `tool_calling` maps to `toolCalling`.
  - `reasoning` maps to model `reasoning` plus configuration controls.
  - `parallel_tool_calls`, `structured_output`, and `pdf_upload` may need internal metadata or documentation-only tracking.

- [ ] Do not advertise unsupported capability behavior to VS Code.
  - If PDF/document input is not converted, do not imply PDF support even if NanoGPT reports `pdf_upload`.
  - If structured output cannot be requested through VS Code, do not imply first-class structured output support.

- [ ] Add tests for capability mapping with all NanoGPT-documented fields.
  - Include a detailed model with `vision`, `reasoning`, `tool_calling`, `parallel_tool_calls`, `structured_output`, and `pdf_upload`.
  - Assert VS Code-visible fields and any internal fields are mapped as designed.

## P2: Naming, Shape, and Maintainability

- [ ] Rename `buildReasoningConfigurationSchema`.
  - It now includes API key, routing mode, provider, and reasoning controls.
  - Suggested names: `buildModelConfigurationSchema` or `buildProviderModelConfigurationSchema`.
  - Update imports, tests, and fallback model setup.

- [ ] Consolidate duplicated configuration schemas.
  - `package.json` provider contribution and runtime model configuration schema should stay in sync.
  - Consider defining schema fragments in TypeScript and documenting the manual package contribution mirror.
  - Avoid generating `package.json` unless the project adopts a build step for manifests.

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

- [ ] Add reasoning option tests.
  - `auto` omits `reasoning_effort`.
  - `none`, `minimal`, `low`, `medium`, `high`, `xhigh` serialize correctly if added.
  - `hidden` sends `reasoning.exclude: true`.
  - `native` and `visible` behavior is intentional and tested.

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
