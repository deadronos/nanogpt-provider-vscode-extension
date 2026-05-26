import { afterEach, describe, expect, test, vi } from "vitest";

type VscodeMockOptions = {
  includePromptTsx?: boolean;
  includeThinkingPart?: boolean;
};

async function loadVscodeMessagingModule(options: VscodeMockOptions = {}) {
  vi.resetModules();
  vi.doMock("vscode", () => {
    class LanguageModelTextPart {
      constructor(public readonly value: string) {}
    }

    class LanguageModelDataPart {
      constructor(
        public readonly data: Uint8Array,
        public readonly mimeType: string,
      ) {}
    }

    class LanguageModelToolCallPart {
      constructor(
        public readonly callId: string,
        public readonly name: string,
        public readonly input: unknown,
      ) {}
    }

    class LanguageModelToolResultPart {
      constructor(
        public readonly callId: string,
        public readonly content: unknown[],
      ) {}
    }

    class LanguageModelPromptTsxPart {
      constructor(public readonly value: string | string[]) {}
    }

    class LanguageModelThinkingPart {
      constructor(public readonly value: string | string[]) {}
    }

    return {
      LanguageModelTextPart,
      LanguageModelDataPart,
      LanguageModelToolCallPart,
      LanguageModelToolResultPart,
      LanguageModelChatToolMode: {
        Required: Symbol("Required"),
        Auto: Symbol("Auto"),
        Default: Symbol("Default"),
      },
      LanguageModelPromptTsxPart: options.includePromptTsx ? LanguageModelPromptTsxPart : undefined,
      LanguageModelThinkingPart: options.includeThinkingPart ? LanguageModelThinkingPart : undefined,
    };
  });

  const vscode = await import("vscode");
  const module = await import("../src/vscode-messaging.js");
  return { vscode, module };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("vscode");
});

describe("VS Code messaging compatibility", () => {
  test("toCoreMessages preserves prompt TSX, tool calls, and tool results when optional APIs exist", async () => {
    const { module, vscode } = await loadVscodeMessagingModule({ includePromptTsx: true });

    const PromptTsxPart = (vscode as any).LanguageModelPromptTsxPart;
    const TextPart = (vscode as any).LanguageModelTextPart;
    const DataPart = (vscode as any).LanguageModelDataPart;
    const ToolCallPart = (vscode as any).LanguageModelToolCallPart;
    const ToolResultPart = (vscode as any).LanguageModelToolResultPart;

    const messages = [
      {
        role: "user",
        content: [
          new TextPart("hello"),
          new PromptTsxPart([" ", "tsx"]),
          new DataPart(new Uint8Array([1, 2, 3]), "application/octet-stream"),
          new ToolCallPart("call-1", "lookup", { id: 1 }),
          new ToolResultPart("call-1", [new TextPart("done"), new PromptTsxPart("!")]),
        ],
      },
    ];

    expect(module.toCoreMessages(messages as any)).toEqual([
      {
        role: "user",
        content: [
          { value: "hello" },
          { value: " tsx" },
          { data: new Uint8Array([1, 2, 3]), mimeType: "application/octet-stream" },
          { callId: "call-1", name: "lookup", input: { id: 1 } },
          { callId: "call-1", content: [{ value: "done" }, { value: "!" }] },
        ],
      },
    ]);
  });

  test("createThinkingPart returns undefined when the VS Code thinking API is unavailable", async () => {
    const { module } = await loadVscodeMessagingModule();

    expect(module.createThinkingPart("hidden")).toBeUndefined();
  });

  test("createThinkingPart returns a thinking part when the VS Code thinking API is available", async () => {
    const { module, vscode } = await loadVscodeMessagingModule({ includeThinkingPart: true });

    const part = module.createThinkingPart("reasoning");

    expect(part).toBeInstanceOf((vscode as any).LanguageModelThinkingPart);
    expect((part as any).value).toBe("reasoning");
  });

  test("toToolMode maps only required mode to the NanoGPT required tool mode", async () => {
    const { module, vscode } = await loadVscodeMessagingModule();

    expect(module.toToolMode((vscode as any).LanguageModelChatToolMode.Required)).toBe("required");
    expect(module.toToolMode((vscode as any).LanguageModelChatToolMode.Auto)).toBeUndefined();
    expect(module.toToolMode(undefined)).toBeUndefined();
  });
});
