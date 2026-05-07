# TODO: Extension Review Follow-up Plan

Date: 2026-05-07
Purpose: Track the concrete follow-up work from the latest full review of the NanoGPT VS Code extension.

## Priority Guide

- P0: User-visible correctness bug or contract violation.
- P1: Important behavior or reliability fix.
- P2: Lower-risk correctness hardening or resilience improvement.

## P0: Fix Mixed Tool Result + Image Message Loss

- [ ] Preserve image parts when a chat turn includes both tool results and fresh multimodal input.
  - Current issue: `toNanoGptMessages()` preserves text plus tool results, but drops image parts once `toolResultMessages.length > 0`.
  - Expected behavior: a mixed message should preserve all non-tool content that NanoGPT can accept, then append tool result messages.
  - Update the conversion logic so text-only and multimodal content are both retained in the pre-tool message.
  - Add a regression test covering one user turn with text, an image `LanguageModelDataPart`, and a tool result.

## P1: Enforce Hidden Reasoning Locally

- [ ] Ensure `reasoningOutput: "hidden"` never surfaces reasoning in VS Code even if NanoGPT streams it anyway.
  - Current issue: the request asks NanoGPT to exclude reasoning, but the extension still reports any received reasoning deltas.
  - Expected behavior: hidden means hidden regardless of upstream behavior.
  - Gate reasoning emission in the provider layer before creating thinking parts or text fallbacks.
  - Add coverage for `hidden`, `native`, and `visible`, including the case where `LanguageModelThinkingPart` is unavailable.

## P1: Fix Token Counting for Tool Results

- [ ] Include nested tool-result payloads in approximate token counting.
  - Current issue: `estimateTokenCount()` only counts top-level text and top-level images, while tool results are nested message content.
  - Expected behavior: provider token estimates should reflect large tool outputs closely enough for VS Code budgeting.
  - Update the estimator or its caller so tool-result text and nested binary/text parts contribute to the count.
  - Add regression tests for large tool-result text and tool-result binary/text payloads.

## P2: Scope Model Discovery Cache More Precisely

- [ ] Prevent allowlist-specific discovery results from sharing the same fallback cache entry.
  - Current issue: model discovery cache keys only include API key and routing mode, but discovery requests also vary by allowlist.
  - Failure mode: if discovery later fails, one provider configuration can fall back to a model list cached for a different allowlist.
  - Include a normalized allowlist component in the cache key, or otherwise partition cached results per effective discovery configuration.
  - Add a targeted test for two configurations with the same key/routing mode and different allowlists.

## Cross-Cutting Validation

- [ ] Add focused regression coverage for the provider/config layer.
  - The current unit suite is green, but the review found gaps in extension-layer behavior.
  - Add the narrowest tests that exercise message conversion, reasoning suppression, token counting, and discovery fallback behavior.

- [ ] Re-run the standard verification commands after each slice is fixed.
  - `npm test`
  - `npm run typecheck`
  - `npm run lint`

## Done Criteria

- Mixed message turns no longer lose images when tool results are present.
- Hidden reasoning is never surfaced locally.
- Tool-result-heavy conversations produce more realistic token estimates.
- Discovery fallback cannot leak models across differing allowlists.
- New regression tests cover each reviewed failure mode.
