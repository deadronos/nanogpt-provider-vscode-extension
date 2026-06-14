import { beforeEach, describe, expect, test, vi } from "vitest";

class EventEmitter<T> {
  readonly event = (_listener: (value: T) => void) => ({ dispose: () => {} });

  fire(_value: T): void {}

  dispose(): void {}
}

const createOutputChannel = vi.fn(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  dispose: vi.fn(),
}));
const registerCommand = vi.fn(() => ({ dispose: () => {} }));
const showWarningMessage = vi.fn();

vi.mock("vscode", () => ({
  EventEmitter,
  commands: {
    registerCommand,
  },
  lm: {},
  window: {
    createOutputChannel,
    showWarningMessage,
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_: string, defaultValue: unknown) => defaultValue),
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: () => {} })),
  },
}));

describe("NanoGPT VS Code compatibility", () => {
  beforeEach(() => {
    createOutputChannel.mockClear();
    registerCommand.mockClear();
    showWarningMessage.mockReset();
  });

  test("activation warns when the language model chat provider API is unavailable", async () => {
    const { activate } = await import("../src/extension.js");

    activate({ subscriptions: [] } as any);

    expect(showWarningMessage).toHaveBeenCalledWith(
      "NanoGPT requires a VS Code build with Language Model Chat Provider support.",
    );
    expect(registerCommand).toHaveBeenCalledTimes(4);
  });
});
