# Extension Host Smoke Test

Date: 2026-05-08
Scope: Manual verification in a VS Code Extension Development Host for the NanoGPT provider integration.

## Prerequisites

- A VS Code build with Language Model Chat Provider support.
- A Copilot setup that allows bring-your-own language model providers.
- A valid NanoGPT API key.
- Extension built and installed in the Extension Development Host.

## Quick Start

1. Build and package the extension:
   - `npm run build`
   - `npm run package`
2. Install the generated VSIX into your test VS Code instance.
3. Open a clean workspace in the Extension Development Host.

## Missing-key onboarding verification

1. Open the Command Palette.
2. Run `Chat: Manage Language Models`.
3. Select or add the `NanoGPT` provider.
4. If the provider prompts for an API key, enter it.
5. If the provider configuration UI is unavailable, run `NanoGPT: Manage API Key` and enter the key through the fallback command.
6. Verify the approved onboarding behavior:
   - In non-silent discovery, the extension should still surface NanoGPT in the add-model flow on a fresh install and offer the `Manage API Key` onboarding action.
   - In silent discovery, the extension must not open any input dialogs or modal prompts.

Expected:

- The extension prompts for a missing API key when the provider has no key configured.
- Non-silent discovery keeps the NanoGPT add-model flow alive even before any provider configuration exists.
- Silent discovery presents a passive warning only, without opening input/modals.
- After onboarding, `NanoGPT` appears in the Chat model picker and model discovery works.
- No missing-key or authentication errors remain.

## Smoke Checklist

### 1. Configure key via Chat provider UI

1. Open Command Palette.
2. Run `Chat: Manage Language Models`.
3. Select the `NanoGPT` provider.
4. Set API key, routing mode, and optional provider.
5. For tool-calling reliability checks, also try `toolCallingStrategy` values `native`, `auto`, and `bridge`.

Expected:

- No key-related errors in Chat.
- `NanoGPT` appears as an available provider.

### 2. Confirm model catalog discovery

1. Open model picker in Chat.
2. Select `NanoGPT` provider.
3. Wait for model list to refresh.

Expected:

- Discovered models appear (not only fallback model).
- Selecting a discovered model succeeds.
- If VS Code shows a rounded or combined "max context" label in some picker or hover surfaces, compare it against the provider tooltip and the Configure view; the extension reports separate input/output limits, but VS Code may synthesize its own combined summary independently.

### 3. Send a basic text chat request

1. Open a new Chat thread.
2. Use a simple prompt: `Reply with exactly: smoke-ok`.
3. Send the prompt with a NanoGPT model selected.

Expected:

- Response arrives without transport/config errors.
- Response body includes `smoke-ok` (or equivalent exact confirmation).

### 4. Verify reasoning output behavior

Use a reasoning-capable model and run these checks:

1. Set reasoning output to `native`.
2. Prompt: `Think step by step and provide the final answer: 27 * 14`.
3. Repeat with reasoning output `hidden`.
4. Repeat with reasoning output `visible` if your VS Code build lacks thinking part support.

Expected:

- `native`: thinking is shown as VS Code thinking parts when supported.
- `hidden`: reasoning stream is suppressed from UI text output.
- `visible`: reasoning appears in normal text stream fallback when native thinking parts are unavailable.

### 5. Verify tool calling end-to-end

1. Use a prompt that triggers tool usage in your environment.
2. Repeat the same prompt with `toolCallingStrategy = native`, then `auto`, then `bridge`.
3. Confirm the model emits tool calls.
4. Confirm tool execution result is returned and incorporated into the final answer.

Expected:

- VS Code receives and surfaces `LanguageModelToolCallPart` events.
- Tool call arguments parse correctly.
- Tool results are sent back and final response continues normally.
- `auto` retries a native empty tool turn once and still produces either text or tool calls.
- `bridge` still produces usable tool calls even when the same model/provider pair is flaky with native tools.

## Suggested Prompt Set

- Text: `Reply with exactly: smoke-ok`
- Reasoning: `Think step by step and provide the final answer: 27 * 14`
- Tool call: `Use available tools to read the workspace README title and return only the title`

## Failure Triage

If a check fails, capture:

- Active model id and routing mode.
- Whether provider config came from `Chat: Manage Language Models` or settings.
- Relevant VS Code logs from the Extension Host.
- Request/response error text shown in Chat.

Common first checks:

- Re-run `NanoGPT: Refresh Models` and retry model selection.
- Confirm API key exists in provider config and is not empty.
- Confirm `routingMode` and `provider` values match intended path.
