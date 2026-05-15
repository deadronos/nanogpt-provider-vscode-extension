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

vi.mock("vscode", () => ({
  LanguageModelTextPart,
  LanguageModelError: class extends Error {},
  LanguageModelChatToolMode,
  workspace: {
    getConfiguration: () => ({ get: () => "" }),
  },
}));

describe("NanoGPT VS Code provider", () => {
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
      { secrets: { get: async () => "test-key" } } as any,
      fakeClient as any,
      logger as any,
    );

    await provider.provideLanguageModelChatResponse(
      { id: "gpt-5.4-mini" } as any,
      [],
      { configuration: { apiKey: "test-key" } },
      { report: (part: unknown) => progressReports.push(part) },
      {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
      } as any,
    );

    expect(progressReports).toHaveLength(1);
    expect(progressReports[0]).toBeInstanceOf(LanguageModelTextPart);
    expect((progressReports[0] as any).value).toBe("Required tool turn failed closed.");

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
