# NanoGPT Surface Audit for VS Code

Date: 2026-05-02
Scope: VS Code language model provider support for chat, reasoning, tool calling, model discovery, and model capabilities.
Out of scope: image generation, video, audio, embeddings, direct web search, web scraping, standalone memory APIs, payment/deposit APIs, and other non-chat endpoints.

## Sources Reviewed

- [NanoGPT introduction](https://docs.nano-gpt.com/introduction)
- [Chat Completions](https://docs.nano-gpt.com/api-reference/endpoint/chat-completion)
- [Models](https://docs.nano-gpt.com/api-reference/endpoint/models)
- [Messages](https://docs.nano-gpt.com/api-reference/endpoint/messages)
- Extension implementation: `src/extension.ts`, `src/client.ts`, `src/nanogpt.ts`

## Executive Summary

The extension targets the right NanoGPT surface for VS Code: OpenAI-compatible chat completions plus detailed model discovery. The current implementation covers the core request shape, streaming text, streaming reasoning fields, OpenAI-compatible function tools, image input through chat messages, and model capability mapping for vision/reasoning/tool calling.

The largest remaining gaps are capability fidelity and option coverage. NanoGPT exposes more capability flags than VS Code currently receives, including `parallel_tool_calls`, `structured_output`, and `pdf_upload`. The chat endpoint also supports more tool-choice forms and reasoning effort values than the extension currently exposes. These are not blockers for a useful VS Code provider, but they are worth tracking so the extension does not accidentally under-advertise models or prevent supported workflows.

## Chat Completions

NanoGPT's recommended text-generation endpoint is `POST /api/v1/chat/completions`. Subscription users can use `POST /api/subscription/v1/chat/completions` to restrict requests to subscription-included models. The extension matches this split with `paygo` and `subscription` routing modes.

Current coverage:

- Sends `Authorization: Bearer <apiKey>` and `Content-Type: application/json`.
- Uses `/api/subscription/v1/chat/completions` for subscription routing and `/api/v1/chat/completions` for pay-as-you-go routing.
- Sends OpenAI-compatible `model`, `messages`, `stream: true`, and optional `max_tokens`.
- Converts VS Code text messages into OpenAI-compatible chat messages.
- Converts VS Code image data parts into OpenAI-compatible `image_url` data URLs for chat vision models.
- Streams `choices[].delta.content` into `LanguageModelTextPart`.
- Supports cancellation via `AbortSignal`.

Notes:

- NanoGPT examples include `Accept: text/event-stream` for SSE streaming. The extension does not send this header. If NanoGPT accepts streamed responses based on `stream: true`, this is fine; adding the header would better match the documented examples.
- The extension deliberately does not expose NanoGPT's broader sampling controls such as `temperature`, `top_p`, penalties, `stop`, `seed`, or structured-output `response_format`. VS Code's provider API may not surface all of these cleanly, so this is acceptable for the current scope.
- The extension does not support the Anthropic-compatible `/api/v1/messages` endpoint. That is fine for this provider because VS Code's language model provider shape maps more naturally to OpenAI-compatible chat completions.

## Reasoning

NanoGPT Chat Completions can stream reasoning separately from visible answer text. The default modern endpoint emits reasoning in `choices[0].delta.reasoning` and final messages can include `message.reasoning`. Compatibility options can switch to `reasoning_content`, and the `v1thinking` endpoint can merge reasoning into normal content for older clients.

Current coverage:

- Parses streamed `delta.reasoning`, `delta.reasoning_content`, and `delta.thinking` fields.
- Reports reasoning via VS Code `LanguageModelThinkingPart` when available.
- Falls back to normal text for reasoning only when `reasoningOutput` is set to `visible` and VS Code lacks thinking-part support.
- Supports hiding reasoning with `reasoning: { exclude: true }` when `reasoningOutput` is `hidden`.
- Sends top-level `reasoning_effort` when configured and not `auto`.
- Exposes model-level configuration for `reasoningEffort` and `reasoningOutput`.

Gaps and risks:

- NanoGPT documents effort values `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`. The extension exposes only `auto`, `low`, `medium`, and `high`. This is conservative, but it means users cannot explicitly disable reasoning with `none` or request `minimal`/`xhigh` from the VS Code model configuration.
- NanoGPT supports `reasoning.effort` as an alternative to top-level `reasoning_effort`; the extension only sends the top-level form. That is acceptable because the docs state the top-level field is authoritative when both exist.
- The extension always includes a `reasoning` object when `reasoningOutput` is set, including the default `native`. This asks NanoGPT not to exclude reasoning. That aligns with the goal of surfacing thinking parts, but it means reasoning-capable models may stream reasoning by default unless the user selects `hidden`.
- The extension does not expose `reasoning.delta_field`, `reasoning_delta_field`, `reasoning_content_compat`, or alternate base URLs (`v1legacy`, `v1thinking`). Because the parser already accepts both modern and common legacy fields, this is probably not needed for VS Code.

Recommended follow-up:

- Consider adding `none`, `minimal`, and `xhigh` to the reasoning effort schema if VS Code UX can tolerate the larger option set.
- Consider renaming `buildReasoningConfigurationSchema` to a more general name because it now also carries API key and routing configuration.

## Tool Calling

NanoGPT Chat Completions supports OpenAI-compatible function calling through `tools`, `tool_choice`, assistant `tool_calls`, and `tool` role messages.

Current coverage:

- Converts VS Code tools to OpenAI-compatible `tools: [{ type: "function", function: { name, description, parameters } }]`.
- Sends `tool_choice: "required"` when VS Code requires tool use.
- Leaves tool choice omitted for auto/default behavior.
- Converts assistant tool-call history into `messages[].tool_calls` with OpenAI-compatible IDs, names, and serialized JSON arguments.
- Converts tool results into `{ role: "tool", tool_call_id, content }` messages.
- Parses streamed `delta.tool_calls` chunks, accumulates function names and argument JSON by index, and emits `LanguageModelToolCallPart`.

Gaps and risks:

- NanoGPT supports `tool_choice: "none"`, `"auto"`, `"required"`, and object-form tool pinning. The extension only sends `"required"`; auto is represented by omission. VS Code may not expose all choices, but if it does, mapping `none` and object-form pinning would improve fidelity.
- NanoGPT supports `parallel_tool_calls`. The extension does not send this flag and does not map the `parallel_tool_calls` model capability. VS Code may still handle multiple returned tool calls because the SSE parser accumulates indexed tool calls, but the model is never explicitly asked to use parallel tool calls.
- NanoGPT documents a 200 KB serialized tools payload limit for Chat Completions and approximately 100 KB per tool call argument for Messages. The extension does not preflight tool spec size. NanoGPT will return a 400 for oversized or invalid specs.
- The extension drops tool result messages if a VS Code message also contains non-tool content in the same message because `toNanoGptMessages` returns only tool result messages when any tool result is present. That may be acceptable for VS Code's expected message shape, but mixed content would be lossy.

Recommended follow-up:

- Map `parallel_tool_calls` from detailed model discovery when VS Code exposes a corresponding capability or option.
- Add defensive tests for multiple streamed tool calls and mixed text/tool result messages.
- Consider surfacing clearer errors for NanoGPT tool validation failures.

## Model Discovery

NanoGPT's `GET /api/v1/models` endpoint returns an OpenAI-compatible model list. With `?detailed=true`, it can include display names, descriptions, context length, max output tokens, pricing, icons, categories, and capabilities. NanoGPT also exposes filtered variants: `/api/subscription/v1/models` for subscription-included text models and `/api/paid/v1/models` for paid/extras.

Current coverage:

- Calls `GET /models?detailed=true` on either `/api/subscription/v1` or `/api/v1`, depending on routing mode.
- Sends `Authorization: Bearer <apiKey>` and `Accept: application/json`.
- Handles both array payloads and OpenAI-compatible `{ data: [...] }` payloads.
- Supports a local model allowlist that bypasses remote discovery and creates model metadata from configured IDs.
- Caches discovered models and falls back to a default model when discovery fails or no key is available.
- Maps `id`, `canonicalId`, `name`, `displayName`, `context_length`, `contextWindow`, `max_output_tokens`, and `maxTokens`.

Gaps and risks:

- NanoGPT documentation says model-list authentication is optional and invalid or missing keys still return model lists, but the extension prompts for a key and skips discovery when no key is resolved. For a VS Code provider, requiring a key before useful chat is reasonable; still, unauthenticated discovery could improve first-run model visibility.
- The extension does not use the paid/extras `/api/paid/v1/models` variant. Paygo mode uses the canonical `/api/v1/models`, which may be filtered by the account's "Also show paid models" preference according to the docs.
- Provider selection discovery via `GET /api/models/:canonicalId/providers` is not implemented. The extension has a free-form `provider` setting and sends it as `X-Provider` in paygo mode.
- Discovery ignores pricing, icon URL, category, provider ownership, and description fields because VS Code's provider metadata has limited places to show them.

Recommended follow-up:

- Decide whether paygo model discovery should use canonical `/api/v1/models`, paid-only `/api/paid/v1/models`, or a merged list.
- Consider unauthenticated discovery for first-run UX, while keeping chat requests gated on a key.
- Consider provider discovery if the extension eventually wants a provider picker instead of a free-form `provider` setting.

## Capabilities

NanoGPT detailed models may include capability flags including `vision`, `reasoning`, `tool_calling`, `parallel_tool_calls`, `structured_output`, and `pdf_upload`.

Current coverage:

- Maps `capabilities.vision` or top-level `vision` to VS Code `capabilities.imageInput`.
- Maps `capabilities.tool_calling` or top-level `tool_calling` to VS Code `capabilities.toolCalling`.
- Maps `capabilities.reasoning` or top-level `reasoning` to model `reasoning`.
- Adds a per-model configuration schema for API key, routing mode, provider, reasoning effort, and reasoning output.
- Treats `context_length` / `contextWindow` as the model's max input token limit directly, and reports `max_output_tokens` / `maxTokens` as a separate max output token limit.

Gaps and risks:

- `parallel_tool_calls` is not represented.
- `structured_output` is not represented and the extension does not expose `response_format`.
- `pdf_upload` is not represented. VS Code data parts that are not images are ignored for normal user messages, though JSON/text tool-result data is converted to text.
- The default fallback model advertises `imageInput: true`, `toolCalling: false`, and `reasoning: true`. If NanoGPT changes that model's actual capabilities, fallback metadata can drift until discovery succeeds.

Recommended follow-up:

- Keep model discovery as the source of truth whenever possible.
- Track unsupported NanoGPT capability flags in code or docs so future VS Code API support can be mapped deliberately.

## Out-of-Scope Surfaces

The following NanoGPT surfaces are intentionally out of scope for this VS Code language model provider audit:

- Image generation and image-model catalogs.
- Video generation and video-model catalogs.
- Audio, speech-to-text, text-to-speech, and music generation.
- Embeddings and embedding-model catalogs.
- Direct web search endpoint `/api/web`.
- Standalone context memory endpoint.
- Web scraping and YouTube transcript endpoints.
- Billing, deposits, invitations, and balance endpoints.
- TEE attestation/signature verification endpoints.

Some chat-adjacent features such as web search suffixes, prompt caching, service tiers, BYOK, X-402 micropayments, and context memory suffixes can still be used indirectly if a user includes supported model suffixes or NanoGPT applies defaults, but the extension does not provide first-class controls for them today.

## Action Checklist

- High: Verify whether `Accept: text/event-stream` should be added to streaming chat requests for stricter docs alignment.
- Medium: Expand reasoning effort options to include `none`, `minimal`, and `xhigh`, or document why the VS Code UX intentionally keeps only `auto`, `low`, `medium`, and `high`.
- Medium: Decide whether paygo discovery should merge or switch to `/api/paid/v1/models` for paid/extras visibility.
- Medium: Add tests for multiple parallel streamed tool calls and mixed-content tool result edge cases.
- Low: Rename `buildReasoningConfigurationSchema` now that it includes connection and routing fields.
- Low: Consider unauthenticated model discovery for first-run browsing before API key configuration.
