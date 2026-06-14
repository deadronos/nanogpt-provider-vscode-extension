import { describe, expect, test, vi } from "vitest";

const LanguageModelTextPart = class {
  value: string;

  constructor(value: string) {
    this.value = value;
  }
};

const LanguageModelChatToolMode = {
  Required: Symbol("Required"),
  Auto: Symbol("Auto"),
  Default: Symbol("Default"),
};

const EventEmitter = class<T> {
  readonly event = (_listener: (value: T) => void) => ({ dispose: () => {} });

  fire(_value: T): void {}

  dispose(): void {}
};

const showWarningMessage = vi.fn();
const executeCommand = vi.fn();

vi.mock("vscode", () => ({
  EventEmitter,
  LanguageModelTextPart,
  LanguageModelError: class extends Error {},
  LanguageModelChatToolMode,
  commands: {
    executeCommand,
  },
  window: {
    showWarningMessage,
  },
  workspace: {
    getConfiguration: () => ({ get: () => "" }),
  },
}));

describe("NanoGPT VS Code provider", () => {
  test("returns fallback models for non-silent unconfigured discovery on fresh installs", async () => {
    const { NanoGptLanguageModelProvider } = await import("../src/extension.js");
    const { DEFAULT_MODELS } = await import("../src/config.js");

    showWarningMessage.mockReset();
    showWarningMessage.mockResolvedValue(undefined);
    executeCommand.mockReset();

    const provider = new NanoGptLanguageModelProvider(
      { secrets: { get: async () => undefined } } as unknown as Parameters<typeof NanoGptLanguageModelProvider>[0],
      { discoverModels: vi.fn() } as unknown as Parameters<typeof NanoGptLanguageModelProvider>[1],
      {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as Parameters<typeof NanoGptLanguageModelProvider>[2],
    );

    const result = await provider.provideLanguageModelChatInformation(
      { silent: false },
      {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
      } as Parameters<typeof provider.provideLanguageModelChatInformation>[1],
    );

    expect(result).toEqual(DEFAULT_MODELS);
    expect(showWarningMessage).toHaveBeenCalledWith(
      "NanoGPT API key is required to discover models. You can manage provider settings or enter a key directly.",
      "Manage API Key",
    );
    expect(executeCommand).not.toHaveBeenCalled();
  });

  test("emits a warning text part and logs bridge telemetry when requiredToolWarning is returned", async () => {
    const { NanoGptLanguageModelProvider } = await import("../src/extension.js");

    const progressReports: Array<unknown> = [];
    const logger = {
      debugMessages: [] as string[],
      infoMessages: [] as string[],
      trace: vi.fn(),
      debug(message: string) {
        this.debugMessages.push(message);
      },
      info(message: string) {
        this.infoMessages.push(message);
      },
      warn: vi.fn(),
      error: vi.fn(),
    };

    const fakeClient = {
      streamChatCompletions: vi.fn(async () => ({
        bridgeTelemetry: {
          bridgeRepairAttempts: 2,
          bridgeRepairSuccesses: 1,
          bridgeRawTextFallbacks: 0,
          bridgeRequiredFailClosed: 1,
        },
        requiredToolWarning: "Required tool turn failed closed.",
      })),
    };

    const provider = new NanoGptLanguageModelProvider(
      { secrets: { get: async () => "test-key" } } as unknown as Parameters<typeof NanoGptLanguageModelProvider>[0],
      fakeClient as unknown as Parameters<typeof NanoGptLanguageModelProvider>[1],
      logger as unknown as Parameters<typeof NanoGptLanguageModelProvider>[2],
    );

    await provider.provideLanguageModelChatResponse(
      { id: "gpt-5.4-mini" } as Parameters<typeof provider.provideLanguageModelChatResponse>[0],
      [],
      { configuration: { apiKey: "test-key" } },
      { report: (part: unknown) => progressReports.push(part) },
      {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
      } as Parameters<typeof provider.provideLanguageModelChatResponse>[4],
    );

    expect(progressReports).toHaveLength(1);
    expect(progressReports[0]).toBeInstanceOf(LanguageModelTextPart);
    expect((progressReports[0] as { value?: string }).value).toBe("Required tool turn failed closed.");

    expect(logger.infoMessages.some((message) =>
      message.includes("textDeltas=1") &&
      message.includes("toolCalls=0"),
    )).toBe(true);

    expect(logger.debugMessages.some((message) =>
      message.includes("textChars=33") &&
      message.includes("bridgeRepairAttempts=2") &&
      message.includes("bridgeRepairSuccesses=1") &&
      message.includes("bridgeRawTextFallbacks=0") &&
      message.includes("bridgeRequiredFailClosed=1"),
    )).toBe(true);
  });
});
