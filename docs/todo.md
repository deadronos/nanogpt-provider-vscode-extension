# Code Review TODO

> Generated: 2026-05-06

This document tracks issues identified during code review of the NanoGPT Provider VS Code Extension.

---

## Critical Issues

- [ ] **[nanogpt-parser.ts:112]** Tool name accumulation bug — `pending.name += toolCall.function.name` concatenates name fragments across chunks instead of replacing. If a tool name is streamed in pieces (e.g., "get" → "Weather" → "For"), the name becomes "getWeatherFor" instead of the final value. Fix: change `+=` to `=`.

- [ ] **[client.ts:241-286]** SSE stream reader not cancelled on abort/timeout — when a user cancels or the timeout fires, the streaming loop breaks via `done: true` but `reader.cancel()` is never called. Add `reader.cancel()` in a finally block or check abort state and cancel proactively.

- [ ] **[extension.ts:424]** `model.internal?.parallelToolCalls` returns `boolean | undefined`. The downstream logic handles this correctly (falsy skips the field), but the type annotation should be explicit to prevent future misuse.

---

## High Priority Issues

- [ ] **[nanogpt-parser.ts:99-106]** Tool call `index === 0` edge case — when `index === 0`, `hasIndex` is true, but `lastSeenIndex` is set to `0` which happens to work for subsequent tool calls without an index. However, the logic is fragile and inconsistent with `isPositiveNumber` which explicitly excludes zero (`value > 0`). Consider clarifying or unifying the validation.

- [ ] **[nanogpt-message.ts:234]** `toNanoGptTools` returns `unknown[]` — loses type information. The return type should be explicitly typed as `Array<{ type: "function"; function: { name: string; description: string; parameters: object } }>`.

- [ ] **[extension.ts:144-164]** `logRuntimeModelResolution` has an unhandled promise rejection path — the function has internal try/catch for `selectChatModels`, but errors thrown after the try/catch block (or in the `model.countTokens` call's outer scope) would propagate as unhandled rejections when called with `void`.

---

## Medium Priority Issues

- [ ] **[nanogpt.ts + package.json]** Configuration schema duplicated — `buildModelConfigurationSchema()` in `src/nanogpt.ts` and the `languageModelChatProviders.configuration` object in `package.json` must be kept in sync manually. The documentation acknowledges this; consider a build step to generate `package.json` from the schema function, or at minimum add a test that compares the two schemas for parity.

- [ ] **[nanogpt.ts:221]** Token count estimate has no upper bound — `Math.max(1, Math.ceil(text.length / 4) + imageCount * 1024)` can return very large values for extremely long inputs without sanity checking against model context limits.

- [ ] **[extension.ts:290]** Cache key includes full API key in memory — `cacheKey = \`${apiKey}|${routingMode}\`` stores the raw API key in a Map key. If the cache object is ever exposed (debugger, heap dump), this could leak credentials. Consider using a hash of the API key instead.

- [ ] **[extension.ts:76,122-123]** Multiple `as` type assertions bypass type safety — `(capabilities as Record<string, unknown>)[key]` and similar casts assume API shapes that could change. Add runtime validation or narrow the types to reduce reliance on unsafe casts.

- [ ] **[extension.ts:541-542]** `isVerboseLoggingEnabled()` called twice in config change handler — minor inefficiency; first call result is stored but function is called again in the `if` condition.

---

## Low Priority Issues

- [ ] **[package.json:198-207]** DevDependencies use caret ranges (`^4.1.5`, etc.) — builds could use different versions over time. Consider pinning exact versions for reproducible CI.

- [ ] **[.env.local]** Contains a real NanoGPT API key — file is in `.gitignore` but poses a risk if accidentally committed or shared. Ensure no secrets are committed and review `process.env.NANOGPT_API_KEY` fallback usage.

- [ ] **[vscode-messaging.ts]** No dedicated test file — `createThinkingPart` and `getPromptTsxText` are tested indirectly through `nanogpt-message.test.ts`. Consider adding unit tests directly in `vscode-messaging.test.ts`.

- [ ] **[nanogpt-parser.ts:98-99]** Comment says "isPositiveNumber requires > 0" but `isPositiveNumber` is not actually used in the parser — the validation is inlined. This comment is misleading.

---

## What Works Well

- **Architecture:** Clean three-layer separation (VS Code integration → Transport → Core) with clear module responsibilities
- **Type safety:** Extensive use of TypeScript types and type guards (`isObject`, `isPositiveNumber`)
- **Test coverage:** 106 tests covering core functionality with good edge case coverage
- **Error handling:** SSE parser gracefully handles malformed JSON; tool call parsing failures are recovered
- **Security:** API keys properly redacted from logs; VS Code secret storage used correctly
- **Schema validation:** Tool payload size validation (200 KB limit) prevents oversized requests
- **Cancellation:** Proper abort signal bridging between VS Code tokens and fetch
- **Documentation:** Architecture docs, AGENTS.md, and changelog are well maintained

---

## Schema Sync Reference

When modifying `NanoGptReasoningEffort` or adding configuration options, update all locations:

| File | What to Update |
|------|---------------|
| `src/nanogpt-types.ts` | Type definition |
| `src/nanogpt.ts` | `buildModelConfigurationSchema()` |
| `src/config.ts` | Validator function |
| `package.json` | `languageModelChatProviders.configuration` + `configuration.properties` |
| `test/*.test.ts` | Corresponding test coverage |