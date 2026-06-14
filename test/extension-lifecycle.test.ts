import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

type VoidListener = () => void;

class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  readonly event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };

  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

let registeredProvider: { onDidChangeLanguageModelChatInformation?: (listener: VoidListener) => { dispose(): void } } | undefined;
let configurationListener:
  | ((event: { affectsConfiguration(section: string): boolean }) => void)
  | undefined;

const createSecrets = () => ({
  delete: vi.fn(async () => undefined),
  get: vi.fn(async () => undefined),
  store: vi.fn(async () => undefined),
});
const createGlobalState = () => {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => store.get(key)),
    update: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    keys: vi.fn(() => Array.from(store.keys())),
  };
};
const createContext = () => ({
  secrets: createSecrets(),
  globalState: createGlobalState(),
  subscriptions: [] as Array<{ dispose(): void }>,
});
const createToken = () => ({
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
});

const createOutputChannel = vi.fn(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  dispose: vi.fn(),
}));
const executeCommand = vi.fn(async (command: string, ...args: unknown[]) => registeredCommands.get(command)?.(...args));
const getCommands = vi.fn(async () => [] as string[]);
const registerCommand = vi.fn((command: string, handler: (...args: unknown[]) => unknown) => {
  registeredCommands.set(command, handler);
  return {
    dispose: () => {
      registeredCommands.delete(command);
    },
  };
});
const onDidChangeConfiguration = vi.fn((listener: (event: { affectsConfiguration(section: string): boolean }) => void) => {
  configurationListener = listener;
  return {
    dispose: () => {
      configurationListener = undefined;
    },
  };
});
const registerLanguageModelChatProvider = vi.fn((vendor: string, provider: unknown) => {
  void vendor;
  registeredProvider = provider as typeof registeredProvider;
  return { dispose: vi.fn() };
});
const showInformationMessage = vi.fn();
const showInputBox = vi.fn();
const showWarningMessage = vi.fn();
const ConfigurationTarget = {
  Global: Symbol("Global"),
  Workspace: Symbol("Workspace"),
  WorkspaceFolder: Symbol("WorkspaceFolder"),
};
const workspaceConfiguration = {
  get: vi.fn((_: string, defaultValue: unknown) => defaultValue),
  inspect: vi.fn(() => undefined),
  update: vi.fn(async () => undefined),
};
const originalNanoGptApiKey = process.env.NANOGPT_API_KEY;

vi.mock("vscode", () => ({
  ConfigurationTarget,
  EventEmitter,
  LanguageModelError: class extends Error {},
  LanguageModelTextPart: class {
    constructor(public readonly value: string) {}
  },
  LanguageModelToolCallPart: class {
    constructor(
      public readonly callId: string,
      public readonly name: string,
      public readonly input: unknown,
    ) {}
  },
  LanguageModelDataPart: class {},
  LanguageModelToolResultPart: class {},
  LanguageModelChatToolMode: {
    Required: Symbol("Required"),
    Auto: Symbol("Auto"),
    Default: Symbol("Default"),
  },
  commands: {
    executeCommand,
    getCommands,
    registerCommand,
  },
  lm: {
    registerLanguageModelChatProvider,
  },
  window: {
    createOutputChannel,
    showInformationMessage,
    showInputBox,
    showWarningMessage,
  },
  workspace: {
    getConfiguration: vi.fn(() => workspaceConfiguration),
    onDidChangeConfiguration,
  },
}));

describe("NanoGPT provider lifecycle", () => {
  beforeEach(() => {
    delete process.env.NANOGPT_API_KEY;
    registeredCommands.clear();
    registeredProvider = undefined;
    configurationListener = undefined;
    createOutputChannel.mockClear();
    executeCommand.mockClear();
    getCommands.mockReset();
    getCommands.mockResolvedValue([]);
    onDidChangeConfiguration.mockClear();
    registerCommand.mockClear();
    registerLanguageModelChatProvider.mockClear();
    showInformationMessage.mockReset();
    showInputBox.mockReset();
    showWarningMessage.mockReset();
    workspaceConfiguration.get.mockClear();
    workspaceConfiguration.get.mockImplementation((_: string, defaultValue: unknown) => defaultValue);
    workspaceConfiguration.inspect.mockReset();
    workspaceConfiguration.inspect.mockReturnValue(undefined);
    workspaceConfiguration.update.mockReset();
    workspaceConfiguration.update.mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (originalNanoGptApiKey === undefined) {
      delete process.env.NANOGPT_API_KEY;
      return;
    }

    process.env.NANOGPT_API_KEY = originalNanoGptApiKey;
  });

  test("manage API key and refresh models notify VS Code that chat models changed", async () => {
    const { activate } = await import("../src/extension.js");

    const context = createContext();

    activate(context as unknown as Parameters<typeof activate>[0]);

    expect(registerLanguageModelChatProvider).toHaveBeenCalledTimes(1);
    expect(registeredProvider?.onDidChangeLanguageModelChatInformation).toBeTypeOf("function");

    const onModelsChanged = vi.fn();
    registeredProvider?.onDidChangeLanguageModelChatInformation?.(onModelsChanged);

    showInputBox.mockResolvedValueOnce("test-key");

    const manageHandler = registeredCommands.get("nanogpt.manage");
    expect(manageHandler).toBeDefined();
    await manageHandler?.();

    expect(context.secrets.store).toHaveBeenCalledWith("nanogpt.apiKey", "test-key");
    expect(onModelsChanged).toHaveBeenCalledTimes(1);

    const refreshHandler = registeredCommands.get("nanogpt.refreshModels");
    expect(refreshHandler).toBeDefined();
    await refreshHandler?.();

    expect(onModelsChanged).toHaveBeenCalledTimes(2);
  });

  test("reset saved configuration can route directly into manage API key onboarding", async () => {
    const { activate } = await import("../src/extension.js");

    const context = createContext();
    await context.globalState.update("nanogpt.modelCache", {
      version: 1,
      entries: {
        subscription: [{ id: "cached-model" }],
      },
    });

    activate(context as unknown as Parameters<typeof activate>[0]);

    const onModelsChanged = vi.fn();
    registeredProvider?.onDidChangeLanguageModelChatInformation?.(onModelsChanged);

    showWarningMessage.mockResolvedValueOnce("Reset NanoGPT");
    showInformationMessage.mockResolvedValueOnce("Manage API Key");
    showInputBox.mockResolvedValueOnce(undefined);
    workspaceConfiguration.inspect.mockImplementation((key: string) => {
      if (key === "apiKey") {
        return { globalValue: "legacy-key", workspaceValue: undefined, workspaceFolderValue: undefined };
      }

      if (key === "routingMode") {
        return { globalValue: undefined, workspaceValue: "paygo", workspaceFolderValue: undefined };
      }

      if (key === "models") {
        return { globalValue: undefined, workspaceValue: undefined, workspaceFolderValue: ["gpt-5.4-mini"] };
      }

      return undefined;
    });

    const resetHandler = registeredCommands.get("nanogpt.resetConfiguration");
    expect(resetHandler).toBeDefined();
    await resetHandler?.();

    expect(context.secrets.delete).toHaveBeenCalledWith("nanogpt.apiKey");
    expect(workspaceConfiguration.update).toHaveBeenCalledWith(
      "apiKey",
      undefined,
      ConfigurationTarget.Global,
    );
    expect(workspaceConfiguration.update).toHaveBeenCalledWith(
      "routingMode",
      undefined,
      ConfigurationTarget.Workspace,
    );
    expect(workspaceConfiguration.update).toHaveBeenCalledWith(
      "models",
      undefined,
      ConfigurationTarget.WorkspaceFolder,
    );
    expect(context.globalState.update).toHaveBeenCalledWith("nanogpt.modelCache", undefined);
    expect(onModelsChanged).toHaveBeenCalledTimes(1);
    expect(showInformationMessage).toHaveBeenCalledWith(
      "NanoGPT saved configuration reset.",
      "Manage API Key",
      "Add Models",
    );
    expect(executeCommand).toHaveBeenCalledWith("nanogpt.manage");
    expect(showInputBox).toHaveBeenCalledTimes(1);
  });

  test("reset saved configuration can reopen VS Code add models flow", async () => {
    const { activate } = await import("../src/extension.js");

    const context = createContext();

    activate(context as unknown as Parameters<typeof activate>[0]);

    showWarningMessage.mockResolvedValueOnce("Reset NanoGPT");
    showInformationMessage.mockResolvedValueOnce("Add Models");
    getCommands.mockResolvedValueOnce(["workbench.action.chat.addModels"]);

    const resetHandler = registeredCommands.get("nanogpt.resetConfiguration");
    expect(resetHandler).toBeDefined();
    await resetHandler?.();

    expect(getCommands).toHaveBeenCalledWith(true);
    expect(executeCommand).toHaveBeenCalledWith("workbench.action.chat.addModels");
    expect(executeCommand).not.toHaveBeenCalledWith("nanogpt.manage");
  });

  test("model-affecting workspace settings changes notify VS Code to rediscover models", async () => {
    const { activate } = await import("../src/extension.js");

    const context = createContext();

    activate(context as unknown as Parameters<typeof activate>[0]);

    const onModelsChanged = vi.fn();
    registeredProvider?.onDidChangeLanguageModelChatInformation?.(onModelsChanged);

    configurationListener?.({
      affectsConfiguration: (section: string) => section === "nanogpt.routingMode",
    });

    expect(onModelsChanged).toHaveBeenCalledTimes(1);
  });

  test("provider-only workspace setting changes do not invalidate the model cache", async () => {
    const { activate } = await import("../src/extension.js");

    const context = createContext();

    activate(context as unknown as Parameters<typeof activate>[0]);

    const onModelsChanged = vi.fn();
    registeredProvider?.onDidChangeLanguageModelChatInformation?.(onModelsChanged);

    configurationListener?.({
      affectsConfiguration: (section: string) => section === "nanogpt.provider",
    });

    expect(onModelsChanged).not.toHaveBeenCalled();
  });

  test("non-silent discovery routes missing-key onboarding directly to NanoGPT management", async () => {
    const { activate } = await import("../src/extension.js");

    showWarningMessage.mockResolvedValueOnce("Manage API Key");

    const context = createContext();

    activate(context as unknown as Parameters<typeof activate>[0]);

    const models = await (registeredProvider as {
      provideLanguageModelChatInformation: (
        options: { silent: boolean; configuration?: { routingMode?: string } },
        token: ReturnType<typeof createToken>,
      ) => Promise<unknown[]>;
    }).provideLanguageModelChatInformation(
      { silent: false, configuration: { routingMode: "subscription" } },
      createToken(),
    );

    expect(models).toHaveLength(5);
    expect(showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("NanoGPT API key"),
      "Manage API Key",
    );
    expect(executeCommand).toHaveBeenCalledWith("nanogpt.manage");
  });

  test("allowlist fallback routes missing-key onboarding directly to NanoGPT management", async () => {
    const { activate } = await import("../src/extension.js");

    showWarningMessage.mockResolvedValueOnce("Manage API Key");

    const context = createContext();

    activate(context as unknown as Parameters<typeof activate>[0]);

    const models = await (registeredProvider as {
      provideLanguageModelChatInformation: (
        options: { silent: boolean; configuration?: { routingMode?: string; models?: string[] } },
        token: ReturnType<typeof createToken>,
      ) => Promise<unknown[]>;
    }).provideLanguageModelChatInformation(
      {
        silent: false,
        configuration: { routingMode: "subscription", models: ["gpt-5.4-mini", "moonshotai/kimi-k2.5"] },
      },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) },
    );

    expect(models.map((model: { id: string; detail: string }) => ({ id: model.id, detail: model.detail }))).toEqual([
      { id: "gpt-5.4-mini", detail: "NanoGPT (unverified)" },
      { id: "moonshotai/kimi-k2.5", detail: "NanoGPT (unverified)" },
    ]);
    expect(showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("NanoGPT API key"),
      "Manage API Key",
    );
    expect(executeCommand).toHaveBeenCalledWith("nanogpt.manage");
  });

  test("silent discovery returns no models and shows no UI when the API key is missing", async () => {
    const { activate } = await import("../src/extension.js");

    const context = createContext();

    activate(context as unknown as Parameters<typeof activate>[0]);

    const token = createToken();

    const firstModels = await (registeredProvider as {
      provideLanguageModelChatInformation: (
        options: { silent: boolean; configuration?: { routingMode?: string } },
        token: ReturnType<typeof createToken>,
      ) => Promise<unknown[]>;
    }).provideLanguageModelChatInformation(
      { silent: true, configuration: { routingMode: "subscription" } },
      token,
    );
    const secondModels = await (registeredProvider as {
      provideLanguageModelChatInformation: (
        options: { silent: boolean; configuration?: { routingMode?: string } },
        token: ReturnType<typeof createToken>,
      ) => Promise<unknown[]>;
    }).provideLanguageModelChatInformation(
      { silent: true, configuration: { routingMode: "subscription" } },
      token,
    );

    expect(firstModels).toEqual([]);
    expect(secondModels).toEqual([]);
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  test("silent discovery on a fresh install prompts directly for the API key", async () => {
    const { activate } = await import("../src/extension.js");

    const context = createContext();

    activate(context as unknown as Parameters<typeof activate>[0]);

    showInputBox.mockResolvedValueOnce(undefined);

    const models = await (registeredProvider as {
      provideLanguageModelChatInformation: (
        options: { silent: boolean; configuration?: { routingMode?: string } },
        token: ReturnType<typeof createToken>,
      ) => Promise<unknown[]>;
    }).provideLanguageModelChatInformation(
      { silent: true },
      createToken(),
    );

    expect(models).toHaveLength(5);
    expect(executeCommand).toHaveBeenCalledWith("nanogpt.manage");
    expect(showInputBox).toHaveBeenCalledTimes(1);
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  test("allowlist fallback returns no models and shows no UI during silent discovery", async () => {
    const { activate } = await import("../src/extension.js");

    const context = createContext();

    activate(context as unknown as Parameters<typeof activate>[0]);

    const firstModels = await (registeredProvider as {
      provideLanguageModelChatInformation: (
        options: { silent: boolean; configuration?: { routingMode?: string; models?: string[] } },
        token: ReturnType<typeof createToken>,
      ) => Promise<unknown[]>;
    }).provideLanguageModelChatInformation(
      {
        silent: true,
        configuration: { routingMode: "subscription", models: ["gpt-5.4-mini"] },
      },
      createToken(),
    );
    const secondModels = await (registeredProvider as {
      provideLanguageModelChatInformation: (
        options: { silent: boolean; configuration?: { routingMode?: string; models?: string[] } },
        token: ReturnType<typeof createToken>,
      ) => Promise<unknown[]>;
    }).provideLanguageModelChatInformation(
      {
        silent: true,
        configuration: { routingMode: "subscription", models: ["gpt-5.4-mini"] },
      },
      createToken(),
    );

    expect(firstModels).toEqual([]);
    expect(secondModels).toEqual([]);
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  test("hydrates model cache from globalState on construction and serves it without re-fetching", async () => {
    const { NanoGptLanguageModelProvider } = await import("../src/extension.js");
    const { sha256Hex } = await import("../src/utils.js");

    const apiKey = "hydrated-key";
    const cacheKey = `subscription:${sha256Hex(apiKey)}:*:*`;
    const cachedModel = {
      id: "hydrated-model",
      name: "Hydrated Model",
      family: "hydrated",
      version: "1",
      maxInputTokens: 1000,
      maxOutputTokens: 100,
      detail: "NanoGPT",
      tooltip: "hydrated tooltip",
      capabilities: {
        imageInput: false,
        toolCalling: false,
        family: "hydrated",
        tokenizer: "o200k_base",
      },
      reasoning: false,
    };

    const context = createContext();
    await context.globalState.update("nanogpt.modelCache", {
      version: 1,
      entries: { [cacheKey]: [cachedModel] },
    });

    const discoverModels = vi.fn();
    const provider = new NanoGptLanguageModelProvider(
      context as unknown as ConstructorParameters<typeof NanoGptLanguageModelProvider>[0],
      { discoverModels } as unknown as ConstructorParameters<typeof NanoGptLanguageModelProvider>[1],
      { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ConstructorParameters<typeof NanoGptLanguageModelProvider>[2],
    );

    const models = await (provider as {
      provideLanguageModelChatInformation: (
        options: { silent: boolean; configuration?: { apiKey?: string; routingMode?: string } },
        token: ReturnType<typeof createToken>,
      ) => Promise<unknown[]>;
    }).provideLanguageModelChatInformation(
      { silent: false, configuration: { apiKey, routingMode: "subscription" } },
      createToken(),
    );

    expect(discoverModels).not.toHaveBeenCalled();
    expect(models[0]?.id).toBe("hydrated-model");
  });

  test("persists discovered models to globalState after a successful discovery", async () => {
    const { NanoGptLanguageModelProvider } = await import("../src/extension.js");
    const { sha256Hex } = await import("../src/utils.js");

    const apiKey = "persist-key";
    const expectedCacheKey = `subscription:${sha256Hex(apiKey)}:*:*`;
    const discoveredModel = {
      id: "discovered-model",
      name: "Discovered Model",
      family: "discovered",
      version: "1",
      maxInputTokens: 200000,
      maxOutputTokens: 32768,
      detail: "NanoGPT",
      tooltip: "discovered tooltip",
      capabilities: {
        imageInput: false,
        toolCalling: false,
        family: "discovered",
        tokenizer: "o200k_base",
      },
      reasoning: false,
    };

    const context = createContext();
    const discoverModels = vi.fn(async () => [discoveredModel]);
    const provider = new NanoGptLanguageModelProvider(
      context as unknown as ConstructorParameters<typeof NanoGptLanguageModelProvider>[0],
      { discoverModels } as unknown as ConstructorParameters<typeof NanoGptLanguageModelProvider>[1],
      { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ConstructorParameters<typeof NanoGptLanguageModelProvider>[2],
    );

    await (provider as {
      provideLanguageModelChatInformation: (
        options: { silent: boolean; configuration?: { apiKey?: string; routingMode?: string } },
        token: ReturnType<typeof createToken>,
      ) => Promise<unknown[]>;
    }).provideLanguageModelChatInformation(
      { silent: false, configuration: { apiKey, routingMode: "subscription" } },
      createToken(),
    );

    expect(context.globalState.update).toHaveBeenCalledWith(
      "nanogpt.modelCache",
      expect.objectContaining({
        version: 1,
        entries: expect.objectContaining({
          [expectedCacheKey]: [discoveredModel],
        }),
      }),
    );
  });

  test("clearModelCache also clears the persisted globalState copy", async () => {
    const { NanoGptLanguageModelProvider } = await import("../src/extension.js");

    const context = createContext();
    const provider = new NanoGptLanguageModelProvider(
      context as unknown as ConstructorParameters<typeof NanoGptLanguageModelProvider>[0],
      { discoverModels: vi.fn() } as unknown as ConstructorParameters<typeof NanoGptLanguageModelProvider>[1],
      { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ConstructorParameters<typeof NanoGptLanguageModelProvider>[2],
    );

    provider.clearModelCache("test-reason");

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(context.globalState.update).toHaveBeenCalledWith("nanogpt.modelCache", undefined);
  });

  test("ignores persisted cache entries with a mismatched schema version", async () => {
    const { NanoGptLanguageModelProvider } = await import("../src/extension.js");
    const { sha256Hex } = await import("../src/utils.js");

    const apiKey = "stale-key";
    const cacheKey = `subscription:${sha256Hex(apiKey)}:*:*`;
    const staleModel = {
      id: "stale-model",
      name: "Stale",
      family: "stale",
      version: "1",
      maxInputTokens: 1000,
      maxOutputTokens: 100,
      detail: "NanoGPT",
      tooltip: "stale",
      capabilities: {
        imageInput: false,
        toolCalling: false,
        family: "stale",
        tokenizer: "o200k_base",
      },
      reasoning: false,
    };

    const context = createContext();
    await context.globalState.update("nanogpt.modelCache", {
      version: 999,
      entries: { [cacheKey]: [staleModel] },
    });

    const discoverModels = vi.fn(async () => [
      { ...staleModel, id: "fresh-model" },
    ]);
    const provider = new NanoGptLanguageModelProvider(
      context as unknown as ConstructorParameters<typeof NanoGptLanguageModelProvider>[0],
      { discoverModels } as unknown as ConstructorParameters<typeof NanoGptLanguageModelProvider>[1],
      { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ConstructorParameters<typeof NanoGptLanguageModelProvider>[2],
    );

    const models = await (provider as {
      provideLanguageModelChatInformation: (
        options: { silent: boolean; configuration?: { apiKey?: string; routingMode?: string } },
        token: ReturnType<typeof createToken>,
      ) => Promise<unknown[]>;
    }).provideLanguageModelChatInformation(
      { silent: false, configuration: { apiKey, routingMode: "subscription" } },
      createToken(),
    );

    expect(discoverModels).toHaveBeenCalledTimes(1);
    expect(models[0]?.id).toBe("fresh-model");
  });
});
