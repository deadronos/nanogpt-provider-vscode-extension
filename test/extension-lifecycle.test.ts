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

  test("manage API key and refresh models notify VS Code that chat models changed", async () => {
    const { activate } = await import("../src/extension.js");

    const secrets = {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
      store: vi.fn(async () => undefined),
    };
    const context = {
      secrets,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    activate(context as any);

    expect(registerLanguageModelChatProvider).toHaveBeenCalledTimes(1);
    expect(registeredProvider?.onDidChangeLanguageModelChatInformation).toBeTypeOf("function");

    const onModelsChanged = vi.fn();
    registeredProvider?.onDidChangeLanguageModelChatInformation?.(onModelsChanged);

    showInputBox.mockResolvedValueOnce("test-key");

    await registeredCommands.get("nanogpt.manage")?.();

    expect(secrets.store).toHaveBeenCalledWith("nanogpt.apiKey", "test-key");
    expect(onModelsChanged).toHaveBeenCalledTimes(1);

    await registeredCommands.get("nanogpt.refreshModels")?.();

    expect(onModelsChanged).toHaveBeenCalledTimes(2);
  });

  test("model-affecting workspace settings changes notify VS Code to rediscover models", async () => {
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

    const onModelsChanged = vi.fn();
    registeredProvider?.onDidChangeLanguageModelChatInformation?.(onModelsChanged);

    configurationListener?.({
      affectsConfiguration: (section: string) => section === "nanogpt.routingMode",
    });

    expect(onModelsChanged).toHaveBeenCalledTimes(1);
  });
});
