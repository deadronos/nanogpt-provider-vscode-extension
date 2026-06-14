# NanoGPT for VS Code — Getting Started

Bring NanoGPT models into the Copilot Chat model picker.

## 1. Save your NanoGPT API key

The NanoGPT extension stores your API key in the VS Code secret storage so it never gets synced or committed to a workspace.

> Open the command palette and run **NanoGPT: Manage API Key**.

The key is read from the secret storage on every chat request; no restart is required.

## 2. Pick NanoGPT models in Copilot Chat

Open Copilot Chat and click the model picker at the top of the panel. NanoGPT-discovered models appear under the `NanoGPT` vendor entry.

> Run **Copilot Chat: Manage Language Models**, then select **NanoGPT** to add it to the picker if it is not already there.

If no models appear yet, the picker falls back to a small default catalogue so you can still send a test message while discovery runs in the background.

## 3. Tune NanoGPT per-model settings

Each NanoGPT model exposes a per-model configuration panel with:

- **Routing surface** — `Subscription` (default) or `Pay as you go`.
- **Reasoning effort** — `auto | none | minimal | low | medium | high | xhigh`.
- **Reasoning output** — `native` (VS Code thinking part) | `hidden` | `visible fallback`.
- **Tool calling strategy** — `native | auto retry | bridge`.

Open the picker → click the gear icon next to a NanoGPT model to edit these fields.

## 4. Verify a chat round-trip

Send a short test message (e.g. "ping") through Copilot Chat with a NanoGPT model selected from the picker. Watch the **Output** panel — NanoGPT logs structured request/response summaries there.

> Run **NanoGPT: Refresh Models** to force a fresh discovery round if the model list looks stale. Enable **NanoGPT: Verbose Logging** in workspace settings (`nanogpt.verboseLogging: true`) for debug-level diagnostics including request IDs, durations, and token counts. No prompts or secrets are ever logged.

## 5. Reset NanoGPT (if you get stuck)

If something goes wrong, you can wipe the extension state in one command:

- Saved API key
- All `nanogpt.*` settings at Global, Workspace, and WorkspaceFolder scopes
- The persisted model cache

> Run **NanoGPT: Reset Saved Configuration** from the command palette.

After the reset, VS Code offers a follow-up menu to re-enter the API key or jump to the model picker.

## 4. Verify a chat round-trip

Send a short message through Copilot Chat using a NanoGPT model. The Output panel (`NanoGPT`) shows a structured log line for the chat request with the chosen model id, routing mode, and duration.

If something looks wrong, enable **NanoGPT: Verbose Logging** in workspace settings to surface debug-level lifecycle events.

## 5. Reset NanoGPT (if you get stuck)

Run **NanoGPT: Reset Saved Configuration** to wipe the saved API key, all `nanogpt.*` settings at every scope, and the cached model list. After the reset completes, VS Code offers a follow-up menu to either re-enter the API key or jump straight to the model picker.
