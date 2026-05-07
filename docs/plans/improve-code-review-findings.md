# Improve Code Review Findings — Implementation Plan

Date: 2026-05-07
Branch: `improve/code-review-findings`

## P1 — Important Fixes

| # | Finding | Improvement | Files |
| --- | --- | --- | --- |
| 1 | Allowlist stubs clone `DEFAULT_MODELS[0]` capabilities — incorrect metadata | Create minimal capability stubs with safe defaults (disable `imageInput`, `toolCalling`, set generic tokenizer), mark as `"NanoGPT (unverified)"` | `src/extension.ts` |
| 2 | `reasoningOutput: "hidden"` sends `{ exclude: true }` — may not match API contract | Omit the `reasoning` field entirely when `reasoningOutput` is `"hidden"`, consistent with the AGENTS.md sentinel pattern | `src/nanogpt-request.ts` |
| 3 | `ProviderConfiguration` uses `unknown` for all fields — no compile-time safety | Not addressed in this phase; low-risk runtime validation covers this | — |

## P2 — Resilience & Quality

| # | Finding | Improvement | Files |
| --- | --- | --- | --- |
| 4 | No `.editorconfig` for consistent formatting | Add `.editorconfig` matching existing conventions (LF, 2-space indent, UTF-8) | New file `.editorconfig` |

## Implementation Order

1. Write this plan doc → `docs/plans/improve-code-review-findings.md`
2. Fix allowlist stub capabilities → `src/extension.ts`
3. Fix reasoning hidden behavior → `src/nanogpt-request.ts`
4. Add `.editorconfig`
5. Run typecheck, lint, and tests → verify all pass

## Verification

- [x] `npm run typecheck` passes
- [x] `npm run lint` passes
- [x] `npm run test` passes (113 tests)