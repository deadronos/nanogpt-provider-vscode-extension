import { beforeEach, describe, expect, test, vi } from "vitest";

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
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_: string, defaultValue: unknown) => defaultValue),
    })),
    onDidChangeConfiguration,
  },
}));

describe("NanoGPT provider lifecycle", () => {
  beforeEach(() => {
    registeredCommands.clear();
    registeredProvider = undefined;
    configurationListener = undefined;
    createOutputChannel.mockClear();
    executeCommand.mockClear();
    getCommands.mockReset();
    onDidChangeConfiguration.mockClear();
    registerCommand.mockClear();
    registerLanguageModelChatProvider.mockClear();
    showInformationMessage.mockReset();
    showInputBox.mockReset();
    showWarningMessage.mockReset();
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

  test("non-silent discovery recommends provider UI before direct API key entry", async () => {
    const { activate } = await import("../src/extension.js");

    getCommands.mockResolvedValueOnce([
      "workbench.action.chat.manageModels",
    ]);
    showWarningMessage.mockResolvedValueOnce("Open Manage Language Models");

    const context = createContext();

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

  test("non-silent discovery can route directly to NanoGPT API key management", async () => {
    const { activate } = await import("../src/extension.js");

    showWarningMessage.mockResolvedValueOnce("Manage API Key Directly");

    const context = createContext();

    activate(context as any);

    await (registeredProvider as any).provideLanguageModelChatInformation(
      { silent: false, configuration: { routingMode: "subscription" } },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) },
    );

    expect(showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("NanoGPT API key"),
      "Open Manage Language Models",
      "Manage API Key Directly",
    );
    expect(executeCommand).toHaveBeenCalledWith("nanogpt.manage");
  });

  test("silent discovery warns only once per session when the API key is missing", async () => {
    const { activate } = await import("../src/extension.js");

    const context = createContext();

    activate(context as any);

    const token = createToken();

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

  test("provider onboarding falls back to direct key management when no provider command is available", async () => {
    const { activate } = await import("../src/extension.js");

    getCommands.mockResolvedValueOnce([]);
    showWarningMessage.mockResolvedValueOnce("Open Manage Language Models");

    const context = createContext();

    activate(context as any);

    await (registeredProvider as any).provideLanguageModelChatInformation(
      { silent: false, configuration: { routingMode: "subscription" } },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any,
    );

    expect(getCommands).toHaveBeenCalled();
    expect(showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("NanoGPT API key"),
      "Open Manage Language Models",
      "Manage API Key Directly",
    );
    expect(executeCommand).toHaveBeenCalledWith("nanogpt.manage");
  });

  test("provider onboarding ignores unrelated openChat runtime commands and falls back to direct management", async () => {
    const { activate } = await import("../src/extension.js");

    getCommands.mockResolvedValueOnce([
      "workbench.action.openChat",
    ]);
    showWarningMessage.mockResolvedValueOnce("Open Manage Language Models");

    const context = createContext();

    activate(context as any);

    await (registeredProvider as any).provideLanguageModelChatInformation(
      { silent: false, configuration: { routingMode: "subscription" } },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any,
    );

    expect(executeCommand).toHaveBeenCalledWith("nanogpt.manage");
    expect(executeCommand).not.toHaveBeenCalledWith("workbench.action.openChat");
  });

  test("provider onboarding falls back to direct management when runtime command enumeration throws", async () => {
    const { activate } = await import("../src/extension.js");

    getCommands.mockRejectedValueOnce(new Error("command enumeration failed"));
    showWarningMessage.mockResolvedValueOnce("Open Manage Language Models");

    const context = createContext();

    activate(context as any);

    await (registeredProvider as any).provideLanguageModelChatInformation(
      { silent: false, configuration: { routingMode: "subscription" } },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any,
    );

    expect(getCommands).toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledWith("nanogpt.manage");
  });

  test("provider onboarding falls back to direct management when discovered runtime command execution throws", async () => {
    const { activate } = await import("../src/extension.js");

    getCommands.mockResolvedValueOnce([
      "workbench.action.chat.manageLanguageModels",
    ]);
    executeCommand.mockRejectedValueOnce(new Error("runtime command failed"));
    showWarningMessage.mockResolvedValueOnce("Open Manage Language Models");

    const context = createContext();

    activate(context as any);

    await (registeredProvider as any).provideLanguageModelChatInformation(
      { silent: false, configuration: { routingMode: "subscription" } },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any,
    );

    expect(executeCommand).toHaveBeenCalledWith("workbench.action.chat.manageLanguageModels");
    expect(executeCommand).toHaveBeenCalledWith("nanogpt.manage");
  });

  test("provider onboarding discovers and executes runtime management commands beyond the hard-coded id", async () => {
    const { activate } = await import("../src/extension.js");

    getCommands.mockResolvedValueOnce([
      "workbench.action.chat.manageLanguageModels",
      "workbench.action.openChat",
    ]);
    showWarningMessage.mockResolvedValueOnce("Open Manage Language Models");

    const context = createContext();

    activate(context as any);

    await (registeredProvider as any).provideLanguageModelChatInformation(
      { silent: false, configuration: { routingMode: "subscription" } },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any,
    );

    expect(executeCommand).toHaveBeenCalledWith("workbench.action.chat.manageLanguageModels");
    expect(executeCommand).not.toHaveBeenCalledWith("workbench.action.openChat");
  });

  test("allowlist fallback still shows non-silent missing-key onboarding guidance", async () => {
    const { activate } = await import("../src/extension.js");

    showWarningMessage.mockResolvedValueOnce("Manage API Key Directly");

    const context = createContext();

    activate(context as any);

    const models = await (registeredProvider as any).provideLanguageModelChatInformation(
      {
        silent: false,
        configuration: { routingMode: "subscription", models: ["gpt-5.4-mini", "moonshotai/kimi-k2.5"] },
      },
      createToken() as any,
    );

    expect(models.map((model: { id: string; detail: string }) => ({ id: model.id, detail: model.detail }))).toEqual([
      { id: "gpt-5.4-mini", detail: "NanoGPT (unverified)" },
      { id: "moonshotai/kimi-k2.5", detail: "NanoGPT (unverified)" },
    ]);
    expect(showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("NanoGPT API key"),
      "Open Manage Language Models",
      "Manage API Key Directly",
    );
    expect(executeCommand).toHaveBeenCalledWith("nanogpt.manage");
  });

  test("allowlist fallback still shows the one-time silent missing-key warning", async () => {
    const { activate } = await import("../src/extension.js");

    const context = createContext();

    activate(context as any);

    await (registeredProvider as any).provideLanguageModelChatInformation(
      {
        silent: true,
        configuration: { routingMode: "subscription", models: ["gpt-5.4-mini"] },
      },
      createToken() as any,
    );
    await (registeredProvider as any).provideLanguageModelChatInformation(
      {
        silent: true,
        configuration: { routingMode: "subscription", models: ["gpt-5.4-mini"] },
      },
      createToken() as any,
    );

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(executeCommand).not.toHaveBeenCalledWith("nanogpt.manage");
  });
});
