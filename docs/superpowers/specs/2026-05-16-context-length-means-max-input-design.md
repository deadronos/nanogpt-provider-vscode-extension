# Treat `context_length` as Max Input Tokens

## Summary

Change the NanoGPT model metadata mapping so the extension reports `context_length` / `contextWindow` as `maxInputTokens` directly, while continuing to report `max_output_tokens` / `maxTokens` separately as `maxOutputTokens`.

This replaces the current behavior that subtracts output tokens from context length.

## Motivation

The current mapper assumes NanoGPT's `context_length` is a combined shared window and derives:

- `maxInputTokens = context_length - max_output_tokens`
- `maxOutputTokens = max_output_tokens`

That assumption is inconsistent with current upstream evidence:

1. NanoGPT's model endpoint documentation says `context_length` represents max input tokens.
2. A live discovery query against NanoGPT using the local `.env.local` key returned:
   - `deepseek/deepseek-v4-flash` → `context_length: 1048576`, `max_output_tokens: 384000`
   - `zai-org/glm-5.1` → `context_length: 200000`, `max_output_tokens: 131072`
   - `moonshotai/kimi-k2.6` → `context_length: 256000`, `max_output_tokens: 65536`

If `context_length` already means max input tokens, subtracting output tokens understates the prompt/input budget and presents incorrect limits to VS Code.

## Goals

- Treat `context_length` / `contextWindow` as `maxInputTokens` directly.
- Keep `max_output_tokens` / `maxTokens` mapped directly to `maxOutputTokens`.
- Preserve all existing capability, family, version, and allowlist behavior.
- Add regression tests using live-like discovery payload values.
- Keep the change narrow and local to model metadata mapping.

## Non-Goals

- No provider-specific overrides for individual model families.
- No support for hypothetical future `max_input_tokens` fields in this change.
- No runtime behavior changes outside model metadata mapping.
- No discovery endpoint or authentication changes.

## Current State

`mapNanoGptModelsToVscode()` in `src/nanogpt.ts` currently:

- reads `context_length` or `contextWindow`
- reads `max_output_tokens` or `maxTokens`
- computes `maxInputTokens` as `contextWindow - maxOutputTokens`

Tests in `test/nanogpt.test.ts` encode that same assumption today.

## Proposed Design

### 1. Remap Input and Output Limits Independently

Update the mapper so the relevant fields are interpreted independently:

- `maxInputTokens = context_length` when present
- `maxInputTokens = contextWindow` when `context_length` is absent
- `maxOutputTokens = max_output_tokens` when present
- `maxOutputTokens = maxTokens` when `max_output_tokens` is absent

Default fallbacks remain acceptable, but the mapper must stop subtracting output from input.

### 2. Update Mapper Documentation

Revise the mapper JSDoc and any nearby comments/docs that currently describe `maxInputTokens` as `contextWindow - maxOutputTokens`.

The new contract should state plainly that NanoGPT's `context_length` is treated as max input tokens.

### 3. Update Regression Coverage

Update existing unit tests that currently expect subtraction behavior.

Add a regression test with live-like payload values covering:

- `deepseek/deepseek-v4-flash`
- `zai-org/glm-5.1`
- `moonshotai/kimi-k2.6`

That test should assert that:

- `maxInputTokens` equals the reported `context_length`
- `maxOutputTokens` equals the reported `max_output_tokens`

### 4. Branching and Implementation Scope

Implementation should happen on a plain new branch in the current checkout, not in a worktree.

The expected code-touch surface is small:

- `src/nanogpt.ts`
- `test/nanogpt.test.ts`
- any concise docs/changelog updates needed to reflect the new mapping contract

## File-Level Plan

### `src/nanogpt.ts`

- change the mapper to assign `maxInputTokens` directly from `context_length` / `contextWindow`
- keep `maxOutputTokens` direct from `max_output_tokens` / `maxTokens`
- update the JSDoc to reflect the new interpretation

### `test/nanogpt.test.ts`

- update expectations that currently subtract output from input
- add live-like regression coverage for DeepSeek, GLM, and Kimi values

### Docs

Update concise references if needed in:

- `CHANGELOG.md`
- `docs/nanogpt-surface-audit.md`

## Validation Plan

### Red-Green Tests

Add or update failing tests first for:

1. `context_length` mapping directly to `maxInputTokens`
2. alias `contextWindow` mapping directly to `maxInputTokens`
3. live-like payload regression values for DeepSeek V4 Flash, GLM 5.1, and Kimi K2.6

### Verification Commands

- `npm test -- test/nanogpt.test.ts`
- `npm run typecheck`
- `npm test`

## Risks and Mitigations

### Risk: NanoGPT semantics differ across endpoints or model families

Mitigation:

- use the upstream docs statement plus current live payload evidence as the mapping contract
- avoid model-specific overrides unless a later payload contradicts that contract

### Risk: Existing users see lower or higher displayed context than before

Mitigation:

- note the mapping correction in the changelog
- keep the fix narrowly scoped to metadata rather than changing request logic

### Risk: Tests still encode the old combined-window assumption

Mitigation:

- update the existing mapper tests and add one explicit regression case using live-like values

## Open Questions Resolved

- Source of truth: NanoGPT docs and live discovery payload
- Interpretation: `context_length` means max input tokens, not shared input-plus-output budget
- Scope: narrow remap only, no provider-specific overrides, no future-field support in this change
