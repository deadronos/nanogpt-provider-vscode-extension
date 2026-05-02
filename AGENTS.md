# NanoGPT Provider for VS Code — Agent Instructions

Unofficial VS Code extension that registers NanoGPT as a VS Code Language Model Chat Provider, exposing NanoGPT models in the Copilot Chat model picker.

## Commands

```bash
npm run build       # Compile TypeScript → dist/
npm run typecheck   # Type-check without emitting
npm run test        # Run unit tests (vitest, no extension host)
npm run package     # Bundle .vsix via vsce
```

## Architecture

Three source files; keep concerns separated:

| File | Responsibility |
| --- | --- |
| `src/nanogpt.ts` | Pure types, transforms, and schema builders. No VS Code API, no I/O. |
| `src/client.ts` | HTTP client: model discovery and streaming chat completions. No VS Code API. |
| `src/extension.ts` | VS Code registration, lifecycle, secrets, configuration resolution. |

Tests live in `test/` and run under Vitest in plain Node — no VS Code APIs are available there.

## Key Conventions

**ESM with `.js` import extensions** — `package.json` has `"type": "module"` and `tsconfig.json` uses `"moduleResolution": "NodeNext"`. All local imports in `src/` must use `.js` file extensions (e.g. `import ... from "./nanogpt.js"`).

**API key as VS Code secret** — The key is stored under secret key `"nanogpt.apiKey"` via `vscode.secrets`. Prefer the provider configuration flow (`Chat: Manage Language Models`) over workspace settings, which can be synced or committed.

**Two routing surfaces** — `subscription` maps to `NANOGPT_SUBSCRIPTION_BASE_URL`; `paygo` maps to `NANOGPT_BASE_URL`. Both are defined in `src/nanogpt.ts`.

**`reasoningEffort: "auto"` is an extension-local sentinel** — It means "omit the field", not "send `auto` to NanoGPT". The seven actual values sent to the API are `none | minimal | low | medium | high | xhigh`.

**Coupled schema changes** — When modifying `NanoGptReasoningEffort` or adding config options, update all four locations together: `src/nanogpt.ts` (type + schema), `src/extension.ts` (validator), `package.json` (contribution schema), and `test/nanogpt.test.ts`.

**`buildModelConfigurationSchema()`** — Must be called per model in `DEFAULT_MODELS` and in model discovery results so VS Code exposes per-provider config fields at both discovery and chat-response time.

**Tests are pure unit tests** — They test `src/nanogpt.ts` and `src/client.ts` logic only. Do not import `vscode` in test files; the extension host is not available in vitest.

## Useful Docs

- [docs/todo.md](docs/todo.md) — Prioritised open work and completed items
- [docs/nanogpt-surface-audit.md](docs/nanogpt-surface-audit.md) — NanoGPT API capability coverage analysis
- [docs/extension-host-smoke-test.md](docs/extension-host-smoke-test.md) — Manual verification checklist for extension host testing
