# Missing API Key Onboarding for NanoGPT Provider Discovery

## Summary

Improve the first-run and missing-key onboarding experience so the extension no longer relies only on `NanoGPT: Manage API Key` when VS Code fails to surface provider setup naturally.

The new behavior should:

1. recommend `Chat: Manage Language Models` as the primary setup path
2. keep `NanoGPT: Manage API Key` available as a direct fallback
3. avoid interactive prompts during silent discovery
4. show at most one passive silent-mode warning per session

This keeps the extension aligned with VS Code's provider UI while preserving a working fallback when that UI is incomplete, delayed, or confusing.

## Motivation

Recent VS Code behavior appears to have shifted enough that NanoGPT setup is not always completed by the provider-management flow alone. In practice, users can end up in a stale or incomplete state where:

- models do not appear until the provider is removed and re-added
- API key setup is not completed until `NanoGPT: Manage API Key` is run manually

The extension already handled model refresh after configuration changes, but the missing-key onboarding flow still assumes that directly opening the NanoGPT key input is the best default fallback. That assumption is now weaker than before.

The onboarding flow should therefore acknowledge two truths at once:

- the VS Code provider-management UI is the preferred setup surface
- the extension still needs a direct key-entry fallback that works when the provider UI does not

## Goals

- Recommend `Chat: Manage Language Models` first when NanoGPT discovery runs without an API key.
- Keep `NanoGPT: Manage API Key` available as an explicit fallback in the same prompt.
- Preserve non-interactive behavior during silent discovery.
- Show a passive silent-mode breadcrumb at most once per session.
- Keep the implementation local to the VS Code integration layer.
- Add focused unit coverage for the onboarding decision paths.

## Non-Goals

- No new persisted state across VS Code restarts.
- No telemetry backend or analytics event collection.
- No attempt to discover NanoGPT models without authentication.
- No new workspace setting to configure onboarding behavior.
- No changes to normal discovery behavior once a valid API key exists.

## Current State

Today, `provideLanguageModelChatInformation()` falls back to `DEFAULT_MODELS` when no API key is available. In non-silent mode it also executes `nanogpt.manage`, which opens the direct NanoGPT key-entry flow.

That means the extension currently treats direct key entry as the only guided onboarding action in the missing-key path. This is functional, but it does not match the intended VS Code provider setup flow described in the README and extension docs.

## Proposed Design

### 1. Add a Dedicated Missing-Key Onboarding Helper

Create a small helper in `src/extension.ts` that handles the missing-key onboarding branch for model discovery.

Responsibilities:

- decide whether the current discovery request is silent or non-silent
- prevent repeated passive warnings during the same session
- show the recommended setup options for non-silent discovery
- gracefully degrade when VS Code provider-management commands are unavailable

This helper should remain extension-owned because it is pure VS Code lifecycle and UI behavior.

### 2. Non-Silent Discovery Uses a Two-Option Action Prompt

When discovery is not silent and no API key is available, the extension should show a user-facing action prompt with two options:

- `Open Manage Language Models`
- `Manage API Key Directly`

Recommended wording should make it clear that the provider UI is preferred.

Expected behavior:

- choosing `Open Manage Language Models` executes the VS Code command that opens language model provider management
- choosing `Manage API Key Directly` executes `nanogpt.manage`
- dismissing the prompt performs no further action for that discovery call

Regardless of the choice, the discovery request still returns fallback models for that call. Actual model availability continues to depend on the existing refresh path after configuration changes.

### 3. Silent Discovery Shows Only a One-Time Passive Warning

When discovery is silent and no API key is available, the extension must not open modals, quick picks, or input boxes.

Instead it should show a passive warning message at most once per session, with copy that points users to:

- `Chat: Manage Language Models`
- `NanoGPT: Manage API Key`

This warning is informational only. It should not trigger commands or request user input.

### 4. Degrade Cleanly if the VS Code Provider Command Is Missing

The preferred onboarding option depends on a VS Code command surface that may vary across builds.

If the language-model management command is unavailable or fails, the extension should fall back cleanly to the direct NanoGPT key-management path rather than leaving the user with a dead action.

The failure should be logged through existing logging, without exposing secrets.

### 5. Keep Discovery and Refresh Ownership Unchanged

This onboarding change must not alter the existing model-refresh ownership added in the previous fix.

That means:

- discovery still returns `DEFAULT_MODELS` when no key exists
- key changes still flow through the existing `nanogpt.manage` command
- model refresh still happens through cache invalidation and `onDidChangeLanguageModelChatInformation`

The onboarding helper only changes how the user is guided into setup when the key is missing.

## File-Level Plan

### `src/extension.ts`

- add a provider-owned helper for missing-key onboarding
- track whether the passive silent warning has already been shown in the current session
- replace the unconditional `nanogpt.manage` fallback in non-silent discovery with the new two-option prompt
- keep fallback model return behavior unchanged

### `test/extension-lifecycle.test.ts`

- add tests for non-silent missing-key discovery choosing the provider-management path
- add tests for non-silent missing-key discovery choosing the direct key-management path
- add a test that silent discovery warns at most once per session
- add a test covering fallback behavior when the VS Code provider-management command is unavailable

### Docs

Update the user-facing setup guidance in:

- `README.md`
- `docs/extension-host-smoke-test.md`
- `CHANGELOG.md`

Documentation should describe the provider UI as preferred and the direct key command as a fallback.

## Control Flow

### Non-Silent Discovery Without API Key

1. `provideLanguageModelChatInformation()` detects that no API key is available.
2. The onboarding helper shows an action prompt with the two setup paths.
3. If the user picks the provider-management option, the extension tries to open that VS Code UI.
4. If that fails or is unavailable, the extension falls back to `nanogpt.manage`.
5. If the user picks direct management, the extension runs `nanogpt.manage`.
6. Discovery returns fallback models for the current call.

### Silent Discovery Without API Key

1. `provideLanguageModelChatInformation()` detects that no API key is available.
2. The onboarding helper checks the session-level warning flag.
3. If the warning has not yet been shown, it shows a passive informational warning.
4. The helper marks the warning as shown.
5. Discovery returns fallback models for the current call.

## Validation Plan

### Red-Green Tests

Add failing tests first for:

1. non-silent missing-key discovery offering and honoring the provider-management path
2. non-silent missing-key discovery offering and honoring the direct key-management path
3. silent missing-key discovery showing only one passive warning across repeated calls
4. provider-management command failure degrading to direct key management

### Verification Commands

- `npm test -- test/extension-lifecycle.test.ts`
- `npm run typecheck`
- `npm test`

## Risks and Mitigations

### Risk: Wrong VS Code command identifier for provider management

Mitigation:

- keep the command access localized in one helper
- test the failure fallback path explicitly
- log the failure and route users to `nanogpt.manage`

### Risk: Silent-mode warning becomes noisy

Mitigation:

- guard it with an in-memory once-per-session flag
- keep the warning informational and non-modal

### Risk: Onboarding prompt blocks discovery or refresh

Mitigation:

- never depend on prompt completion to return discovery results
- preserve fallback model return behavior for the current call

## Open Questions Resolved

- Primary setup path: recommend `Chat: Manage Language Models`
- Secondary setup path: keep `NanoGPT: Manage API Key`
- Silent discovery behavior: passive warning only, at most once per session
- Missing-key fallback result: continue returning fallback models for the active discovery call
