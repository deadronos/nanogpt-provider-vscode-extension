# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- (nothing yet)

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