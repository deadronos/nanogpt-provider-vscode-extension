# Missing API Key Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guide users into NanoGPT setup more reliably when model discovery runs without an API key by recommending the provider UI first, keeping direct key entry as a fallback, and avoiding intrusive prompts during silent discovery.

**Architecture:** Keep the change localized to the VS Code integration layer in `src/extension.ts`. Add a provider-owned onboarding helper that distinguishes silent vs non-silent discovery, probes available VS Code commands at runtime for a language-model management entry point, falls back to `nanogpt.manage` when needed, and preserves the existing fallback-model return path.

**Tech Stack:** TypeScript, VS Code extension API, Vitest

---

## File Map

- Modify `src/extension.ts`
  Own the missing-key onboarding helper, session warning guard, and runtime command probe.
- Modify `test/extension-lifecycle.test.ts`
  Add lifecycle coverage for non-silent onboarding actions, silent-mode warning throttling, and provider-command fallback.
- Modify `README.md`
  Update setup guidance to describe the provider UI as preferred and the direct key command as a fallback.
- Modify `docs/extension-host-smoke-test.md`
  Add a manual verification path for missing-key onboarding behavior.
- Modify `CHANGELOG.md`
  Record the onboarding improvement in `Unreleased`.

### Task 1: Add failing lifecycle tests for missing-key onboarding

**Files:**

- Modify: `test/extension-lifecycle.test.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Extend the VS Code mock to expose command discovery and message choices**

Add `getCommands` to the mocked `vscode.commands` object and keep the UI mocks resettable so the new lifecycle tests can steer each onboarding path.

```ts
const getCommands = vi.fn(async () => [] as string[]);
const showWarningMessage = vi.fn();

vi.mock("vscode", () => ({
  EventEmitter,
  commands: {
    executeCommand,
    getCommands,
    registerCommand,
  },
  window: {
    createOutputChannel,
    showInformationMessage,
    showInputBox,
    showWarningMessage,
  },
  // ...existing mock members...
}));

beforeEach(() => {
  getCommands.mockReset();
  showWarningMessage.mockReset();
});
```

- [ ] **Step 2: Write the failing non-silent provider-UI test**

Add a new test that drives discovery with no API key, chooses the provider-management option, and expects the runtime-probed command to run instead of `nanogpt.manage`.

```ts
test("non-silent discovery recommends provider UI before direct API key entry", async () => {
  const { activate } = await import("../src/extension.js");

  getCommands.mockResolvedValueOnce([
    "workbench.action.chat.manageModels",
  ]);
  showWarningMessage.mockResolvedValueOnce("Open Manage Language Models");

  const context = {
    secrets: {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
      store: vi.fn(async () => undefined),
    },
    subscriptions: [] as Array<{ dispose(): void }>,
  };

  activate(context as any);

  const models = await (registeredProvider as any).provideLanguageModelChatInformation(
    { silent: false, configuration: { routingMode: "subscription" } },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) },
  );

  expect(models).toHaveLength(1);
  expect(showWarningMessage).toHaveBeenCalledWith(
    expect.stringContaining("NanoGPT API key"),
    "Open Manage Language Models",
    "Manage API Key Directly",
  );
  expect(executeCommand).toHaveBeenCalledWith("workbench.action.chat.manageModels");
  expect(executeCommand).not.toHaveBeenCalledWith("nanogpt.manage");
});
```

- [ ] **Step 3: Write the failing direct-key and silent-warning tests**

Cover the explicit fallback branch and the once-per-session passive warning branch.

```ts
test("non-silent discovery can route directly to NanoGPT API key management", async () => {
  const { activate } = await import("../src/extension.js");

  showWarningMessage.mockResolvedValueOnce("Manage API Key Directly");

  const context = {
    secrets: {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
      store: vi.fn(async () => undefined),
    },
    subscriptions: [] as Array<{ dispose(): void }>,
  };

  activate(context as any);

  await (registeredProvider as any).provideLanguageModelChatInformation(
    { silent: false, configuration: { routingMode: "subscription" } },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) },
  );

  expect(executeCommand).toHaveBeenCalledWith("nanogpt.manage");
});

test("silent discovery warns only once per session when the API key is missing", async () => {
  const { activate } = await import("../src/extension.js");

  const context = {
    secrets: {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
      store: vi.fn(async () => undefined),
    },
    subscriptions: [] as Array<{ dispose(): void }>,
  };

  activate(context as any);

  const token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => {} }),
  };

  await (registeredProvider as any).provideLanguageModelChatInformation(
    { silent: true, configuration: { routingMode: "subscription" } },
    token as any,
  );
  await (registeredProvider as any).provideLanguageModelChatInformation(
    { silent: true, configuration: { routingMode: "subscription" } },
    token as any,
  );

  expect(showWarningMessage).toHaveBeenCalledTimes(1);
  expect(executeCommand).not.toHaveBeenCalledWith("nanogpt.manage");
});
```

- [ ] **Step 4: Write the failing provider-command fallback test**

Cover the case where a provider-management command is not discoverable and the onboarding helper must degrade to `nanogpt.manage`.

```ts
test("provider onboarding falls back to direct key management when no provider command is available", async () => {
  const { activate } = await import("../src/extension.js");

  getCommands.mockResolvedValueOnce([]);
  showWarningMessage.mockResolvedValueOnce("Open Manage Language Models");

  const context = {
    secrets: {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
      store: vi.fn(async () => undefined),
    },
    subscriptions: [] as Array<{ dispose(): void }>,
  };

  activate(context as any);

  await (registeredProvider as any).provideLanguageModelChatInformation(
    { silent: false, configuration: { routingMode: "subscription" } },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any,
  );

  expect(executeCommand).toHaveBeenCalledWith("nanogpt.manage");
});
```

- [ ] **Step 5: Run the lifecycle test file to verify RED**

Run: `npm test -- test/extension-lifecycle.test.ts`

Expected: FAIL with missing-key onboarding assertions because discovery currently calls `nanogpt.manage` directly in non-silent mode and does not throttle silent warnings.

### Task 2: Implement provider-owned missing-key onboarding in discovery

**Files:**

- Modify: `src/extension.ts`
- Test: `test/extension-lifecycle.test.ts`

- [ ] **Step 1: Add provider-owned labels, session state, and command-probe helpers**

Insert constants and helper methods near `NanoGptLanguageModelProvider` so the onboarding logic has one local ownership point.

```ts
const OPEN_MANAGE_LANGUAGE_MODELS_ACTION = "Open Manage Language Models";
const MANAGE_API_KEY_DIRECTLY_ACTION = "Manage API Key Directly";

function findManageLanguageModelsCommand(availableCommands: readonly string[]): string | undefined {
  return availableCommands.find((command) =>
    /manage/i.test(command) && /(language.?model|chat.*model|model.*chat)/i.test(command),
  );
}

export class NanoGptLanguageModelProvider implements ChatProviderApi {
  private readonly modelCache = new Map<string, VscodeModelMetadata[]>();
  private readonly modelChangeEmitter = new vscode.EventEmitter<void>();
  private hasShownMissingApiKeySilentWarning = false;
  // ...existing members...
}
```

- [ ] **Step 2: Add the onboarding helper methods**

Implement a small branch that handles non-silent action prompts, silent one-time warnings, and provider-command fallback.

```ts
private async openManageLanguageModelsOrFallback(): Promise<void> {
  const availableCommands = await vscode.commands.getCommands(true);
  const manageCommand = findManageLanguageModelsCommand(availableCommands);

  if (manageCommand) {
    await vscode.commands.executeCommand(manageCommand);
    this.logger.info(`[provider] opened language model management (${formatKeyValuePairs({ command: manageCommand })})`);
    return;
  }

  this.logger.warn("[provider] language model management command unavailable; falling back to NanoGPT API key management");
  await vscode.commands.executeCommand("nanogpt.manage");
}

private async handleMissingApiKeyDiscovery(silent: boolean): Promise<void> {
  if (silent) {
    if (!this.hasShownMissingApiKeySilentWarning) {
      this.hasShownMissingApiKeySilentWarning = true;
      void vscode.window.showWarningMessage(
        "NanoGPT needs an API key. Use Chat: Manage Language Models or NanoGPT: Manage API Key.",
      );
    }
    return;
  }

  const selection = await vscode.window.showWarningMessage(
    "NanoGPT API key is not configured. Open Manage Language Models first, or enter the key directly.",
    OPEN_MANAGE_LANGUAGE_MODELS_ACTION,
    MANAGE_API_KEY_DIRECTLY_ACTION,
  );

  if (selection === OPEN_MANAGE_LANGUAGE_MODELS_ACTION) {
    await this.openManageLanguageModelsOrFallback();
    return;
  }

  if (selection === MANAGE_API_KEY_DIRECTLY_ACTION) {
    await vscode.commands.executeCommand("nanogpt.manage");
  }
}
```

- [ ] **Step 3: Replace the direct missing-key branch in discovery**

Update the `!apiKey` discovery path to use the onboarding helper while keeping the current fallback-model behavior unchanged.

```ts
if (!apiKey) {
  this.logger.warn(
    `[${requestId}] model discovery missing API key; returning fallback models (${formatKeyValuePairs({
      silent: options.silent,
      routingMode,
      durationMs: Date.now() - startedAt,
    })})`,
  );
  await this.handleMissingApiKeyDiscovery(options.silent);
  return DEFAULT_MODELS;
}
```

- [ ] **Step 4: Run the lifecycle test file to verify GREEN**

Run: `npm test -- test/extension-lifecycle.test.ts`

Expected: PASS. The new onboarding tests and the existing model-refresh tests should all pass.

### Task 3: Update user-facing docs for the new onboarding behavior

**Files:**

- Modify: `README.md`
- Modify: `docs/extension-host-smoke-test.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update the README setup section**

Adjust the setup copy so it matches the new extension behavior and makes the provider UI recommendation explicit.

```md
## Setup

After installing the extension:

1. Open the Command Palette.
2. Run `Chat: Manage Language Models`.
3. Add or configure the `NanoGPT` provider.
4. Enter your NanoGPT API key when prompted.
5. If VS Code does not complete provider setup cleanly, run `NanoGPT: Manage API Key` as a direct fallback.
6. Open VS Code Chat and select a NanoGPT model from the model picker.

If NanoGPT discovery runs before a key is configured, the extension now recommends `Chat: Manage Language Models` first and keeps `NanoGPT: Manage API Key` available as a fallback.
```

- [ ] **Step 2: Update the extension-host smoke test**

Add a short missing-key onboarding verification path so the manual checklist covers the new flow.

```md
### 1a. Verify missing-key onboarding

1. Remove any stored NanoGPT API key.
2. Trigger NanoGPT model discovery from Chat.
3. In a non-silent flow, confirm the extension offers `Open Manage Language Models` and `Manage API Key Directly`.
4. Trigger discovery again in a background or silent flow and confirm the extension shows at most one passive warning.

Expected:

- Non-silent discovery recommends the provider UI first.
- Direct key management remains available as a fallback.
- Silent discovery does not open an input box or modal picker.
```

- [ ] **Step 3: Add the changelog entry**

Record the onboarding improvement in `Unreleased`.

```md
- Improved missing-key onboarding: when NanoGPT discovery runs without an API key, the extension now recommends `Chat: Manage Language Models` first, keeps `NanoGPT: Manage API Key` as a direct fallback, and limits silent-mode setup warnings to one passive breadcrumb per session.
```

- [ ] **Step 4: Run the docs-adjacent verification commands**

Run: `npm run typecheck`

Expected: PASS with no TypeScript errors after the onboarding helper is wired into `src/extension.ts`.

### Task 4: Run full verification and handoff

**Files:**

- Modify: `src/extension.ts`
- Modify: `test/extension-lifecycle.test.ts`
- Modify: `README.md`
- Modify: `docs/extension-host-smoke-test.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: PASS with all Vitest files green, including the onboarding lifecycle tests.

- [ ] **Step 2: Inspect the final diff for scope control**

Run: `git diff -- src/extension.ts test/extension-lifecycle.test.ts README.md docs/extension-host-smoke-test.md CHANGELOG.md`

Expected: only the onboarding helper, lifecycle tests, and related documentation updates appear.

- [ ] **Step 3: Manual spot-check in the extension host if available**

Run this interaction manually:

```text
1. Start the Extension Development Host.
2. Clear the NanoGPT secret-stored API key.
3. Trigger NanoGPT model discovery from Chat.
4. Choose Open Manage Language Models and confirm the provider UI opens or the extension falls back to direct key management.
5. Repeat with silent discovery and confirm only one passive warning appears.
```

Expected: the new onboarding guidance matches the documented flow and does not block fallback model discovery.

## Self-Review

- Spec coverage: the tasks cover the approved hybrid onboarding prompt, the silent-mode breadcrumb limit, provider-command fallback, and the required docs updates.
- Placeholder scan: all tasks include concrete files, commands, expected outcomes, and code snippets.
- Type consistency: the helper names used across tasks are `findManageLanguageModelsCommand`, `openManageLanguageModelsOrFallback`, and `handleMissingApiKeyDiscovery`.
