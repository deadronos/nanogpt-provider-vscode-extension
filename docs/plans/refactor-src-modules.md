# Plan: Refactor src/ into Fine-Grained Modules

**Date:** 2026-05-02
**Status:** In Progress

## Motivation

`src/extension.ts` (803 lines) and `src/nanogpt.ts` (790 lines) each contain 5+ orthogonal responsibilities. Splitting them into focused, single-responsibility modules improves readability, testability, and reduces risk of coupling drift. `src/client.ts` (358 lines) is already cohesive.

## Final Module Map

```
src/
  utils.ts              — shared helpers (abort, formatting, predicates)
  nanogpt-types.ts      — API types, constants, resolveRole
  nanogpt-message.ts    — message/part conversion, tool serialization
  nanogpt-request.ts    — request body/header builder
  nanogpt-parser.ts     — SSE parser + collectors
  nanogpt.ts            — model mapping, schema, token estimation, barrel re-exports
  client.ts             — HTTP client (imports from utils, nanogpt-parser)
  config.ts             — VS Code configuration resolution
  logging.ts            — output channel logger
  vscode-messaging.ts   — VS Code message-part compatibility
  extension.ts          — provider class, activation, commands

test/
  utils.test.ts         — NEW: shared utility tests
  nanogpt-types.test.ts — NEW: resolveRole smoke test
  nanogpt-message.test.ts — NEW: message conversion tests
  nanogpt-request.test.ts — NEW: request building tests
  nanogpt-parser.test.ts — NEW: SSE parser tests
  nanogpt.test.ts       — model mapping, schema, token estimation
  client.test.ts        — HTTP client (minimal import updates)
```

## Phase 1: Create docs/plans/ directory and this document ✅

## Phase 2: Extract `src/utils.ts`

Move cross-cutting helpers:
- From `nanogpt.ts`: `isPositiveNumber`, `isObject`, `toBase64`, `getTextPartValue`
- From `extension.ts`: `formatKeyValuePairs`, `summarizeMessages`, `summarizeTools`, `formatRoleCounts`, `formatError`, `createAbortSignal`
- From `client.ts`: `withTimeout`, `getHeader`

## Phase 3: Split `src/nanogpt.ts` into sub-modules

### 3a: `src/nanogpt-types.ts`
- API URL constants: `NANOGPT_BASE_URL`, `NANOGPT_SUBSCRIPTION_BASE_URL`
- All type definitions
- `resolveRole`

### 3b: `src/nanogpt-message.ts`
- `toNanoGptMessages`, `toNanoGptImagePart`, `toToolCall`, `toToolResultContent`, `toNanoGptTools`

### 3c: `src/nanogpt-request.ts`
- `buildNanoGptChatCompletionRequest`

### 3d: `src/nanogpt-parser.ts`
- `NanoGptSseParser`, `collectSseResponseParts`, `collectSseTextDeltas`

### 3e: `src/nanogpt.ts` (reduced to barrel)
- `mapNanoGptModelsToVscode`, `buildModelConfigurationSchema`, `estimateTokenCount`
- Re-exports from sub-modules

## Phase 4: Split `src/extension.ts` into sub-modules

### 4a: `src/config.ts`
- Config resolution functions, `DEFAULT_MODELS`, config types

### 4b: `src/logging.ts`
- Logger creation and output channel

### 4c: `src/vscode-messaging.ts`
- VS Code message-part compatibility: `toCoreMessages`, `toToolMode`, `createThinkingPart`, `getPromptTsxText`

### 4d: `src/extension.ts` (reduced)
- `NanoGptLanguageModelProvider`, `activate`, `deactivate`

## Phase 5: Update `src/client.ts` imports

## Phase 6: Update tests to match new module structure

## Phase 7: Update architecture documentation

- `docs/architecture/current-architecture.md`
- `docs/architecture/contracts-and-invariants.md`
- `docs/architecture/runtime-flows.md`
- `docs/architecture/README.md`
- `AGENTS.md`
- `CHANGELOG.md`

## Verification

```bash
npm run typecheck  # zero errors
npm run test       # all green
npm run build      # clean compilation
```

## Design Constraints Preserved

- ESM `.js` import extensions maintained throughout
- `client.ts` and `nanogpt*.ts` files have no VS Code imports
- `nanogpt*.ts` files remain pure and deterministic
- All existing test semantics preserved
- Schema coupling between `buildModelConfigurationSchema()` and `package.json` maintained
