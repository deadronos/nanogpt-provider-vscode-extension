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
const createContext = () => ({
  secrets: createSecrets(),
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
const originalNanoGptApiKey = process.env.NANOGPT_API_KEY;

vi.mock("vscode", () => ({
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
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_: string, defaultValue: unknown) => defaultValue),
    })),
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
    onDidChangeConfiguration.mockClear();
    registerCommand.mockClear();
    registerLanguageModelChatProvider.mockClear();
    showInformationMessage.mockReset();
    showInputBox.mockReset();
    showWarningMessage.mockReset();
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

    activate(context as any);

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

  test("model-affecting workspace settings changes notify VS Code to rediscover models", async () => {
    const { activate } = await import("../src/extension.js");

    const context = createContext();

    activate(context as any);

    const onModelsChanged = vi.fn();
    registeredProvider?.onDidChangeLanguageModelChatInformation?.(onModelsChanged);

    configurationListener?.({
      affectsConfiguration: (section: string) => section === "nanogpt.routingMode",
    });

    expect(onModelsChanged).toHaveBeenCalledTimes(1);
  });

  test("non-silent discovery routes missing-key onboarding directly to NanoGPT management", async () => {
    const { activate } = await import("../src/extension.js");

    showWarningMessage.mockResolvedValueOnce("Manage API Key");

    const context = createContext();

    activate(context as any);

    const models = await (registeredProvider as any).provideLanguageModelChatInformation(
      { silent: false, configuration: { routingMode: "subscription" } },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) },
    );

    expect(models).toHaveLength(1);
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

    activate(context as any);

    const models = await (registeredProvider as any).provideLanguageModelChatInformation(
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

    activate(context as any);

    const token = createToken();

    const firstModels = await (registeredProvider as any).provideLanguageModelChatInformation(
      { silent: true, configuration: { routingMode: "subscription" } },
      token as any,
    );
    const secondModels = await (registeredProvider as any).provideLanguageModelChatInformation(
      { silent: true, configuration: { routingMode: "subscription" } },
      token as any,
    );

    expect(firstModels).toEqual([]);
    expect(secondModels).toEqual([]);
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  test("allowlist fallback returns no models and shows no UI during silent discovery", async () => {
    const { activate } = await import("../src/extension.js");

    const context = createContext();

    activate(context as any);

    const firstModels = await (registeredProvider as any).provideLanguageModelChatInformation(
      {
        silent: true,
        configuration: { routingMode: "subscription", models: ["gpt-5.4-mini"] },
      },
      createToken() as any,
    );
    const secondModels = await (registeredProvider as any).provideLanguageModelChatInformation(
      {
        silent: true,
        configuration: { routingMode: "subscription", models: ["gpt-5.4-mini"] },
      },
      createToken() as any,
    );

    expect(firstModels).toEqual([]);
    expect(secondModels).toEqual([]);
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
