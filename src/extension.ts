import * as vscode from "vscode";
import { NanoGptClient } from "./client.js";
import {
  estimateTokenCount,
  toNanoGptMessages,
  type NanoGptRoutingMode,
  type VscodeModelMetadata,
} from "./nanogpt.js";

const VENDOR_ID = "nanogpt";
const SECRET_KEY = "nanogpt.apiKey";
const DEFAULT_MODELS: VscodeModelMetadata[] = [
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    family: "nanogpt",
    version: "nano-gpt",
    maxInputTokens: 167232,
    maxOutputTokens: 32768,
    detail: "NanoGPT",
    tooltip: "NanoGPT model gpt-5.4-mini",
    capabilities: {
      imageInput: true,
      toolCalling: false,
    },
  },
];

type ChatProviderApi = {
  provideLanguageModelChatInformation(
    options: { silent: boolean },
    token: vscode.CancellationToken,
  ): Promise<VscodeModelMetadata[]>;
  provideLanguageModelChatResponse(
    model: VscodeModelMetadata,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: { modelOptions?: { maxTokens?: number } },
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void>;
  provideTokenCount(
    model: VscodeModelMetadata,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Promise<number>;
};

function getConfig() {
  return vscode.workspace.getConfiguration("nanogpt");
}

function getRoutingMode(): NanoGptRoutingMode {
  const value = getConfig().get<string>("routingMode", "subscription");
  return value === "paygo" ? "paygo" : "subscription";
}

async function resolveApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return (
    (await context.secrets.get(SECRET_KEY))?.trim() ||
    getConfig().get<string>("apiKey", "").trim() ||
    process.env.NANOGPT_API_KEY?.trim()
  );
}

function createAbortSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  }
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

function toCoreMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): Parameters<typeof toNanoGptMessages>[0] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map((part) => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return { value: part.value };
      }
      if (part instanceof vscode.LanguageModelDataPart) {
        return { data: part.data, mimeType: part.mimeType };
      }
      return {};
    }),
  }));
}

class NanoGptLanguageModelProvider implements ChatProviderApi {
  private cachedModels: VscodeModelMetadata[] | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: NanoGptClient,
  ) {}

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    token: vscode.CancellationToken,
  ): Promise<VscodeModelMetadata[]> {
    const apiKey = await resolveApiKey(this.context);
    const allowlist = getConfig().get<string[]>("models", []);

    if (allowlist.length > 0) {
      const models = allowlist.map((id) => ({
        ...DEFAULT_MODELS[0],
        id,
        name: id,
        tooltip: `NanoGPT model ${id}`,
      }));
      this.cachedModels = models;
      return models;
    }

    if (!apiKey) {
      if (!options.silent) {
        await vscode.commands.executeCommand("nanogpt.manage");
      }
      return this.cachedModels ?? DEFAULT_MODELS;
    }

    try {
      const models = await this.client.discoverModels({
        apiKey,
        routingMode: getRoutingMode(),
        signal: createAbortSignal(token),
      });
      this.cachedModels = models.length > 0 ? models : DEFAULT_MODELS;
      return this.cachedModels;
    } catch (err) {
      if (!options.silent) {
        void vscode.window.showWarningMessage(
          `NanoGPT model discovery failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return this.cachedModels ?? DEFAULT_MODELS;
    }
  }

  async provideLanguageModelChatResponse(
    model: VscodeModelMetadata,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: { modelOptions?: { maxTokens?: number } },
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const apiKey = await resolveApiKey(this.context);
    if (!apiKey) {
      throw new vscode.LanguageModelError("NanoGPT API key is not configured");
    }

    await this.client.streamChatCompletions({
      apiKey,
      modelId: model.id,
      messages: toNanoGptMessages(toCoreMessages(messages)),
      routingMode: getRoutingMode(),
      provider: getConfig().get<string>("provider", ""),
      maxTokens: options.modelOptions?.maxTokens,
      signal: createAbortSignal(token),
      onText: (text) => progress.report(new vscode.LanguageModelTextPart(text)),
    });
  }

  async provideTokenCount(
    _model: VscodeModelMetadata,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === "string") {
      return estimateTokenCount(text);
    }

    return estimateTokenCount(toCoreMessages([text])[0]);
  }

  clearModelCache(): void {
    this.cachedModels = undefined;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new NanoGptLanguageModelProvider(context, new NanoGptClient());
  const lm = vscode.lm as typeof vscode.lm & {
    registerLanguageModelChatProvider?: (
      vendor: string,
      provider: ChatProviderApi,
    ) => vscode.Disposable;
  };

  if (typeof lm.registerLanguageModelChatProvider === "function") {
    context.subscriptions.push(lm.registerLanguageModelChatProvider(VENDOR_ID, provider));
  } else {
    void vscode.window.showWarningMessage(
      "NanoGPT requires a VS Code build with Language Model Chat Provider support.",
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("nanogpt.manage", async () => {
      const apiKey = await vscode.window.showInputBox({
        title: "NanoGPT API key",
        prompt: "Enter a NanoGPT API key",
        password: true,
        ignoreFocusOut: true,
      });
      if (apiKey === undefined) {
        return;
      }

      if (apiKey.trim()) {
        await context.secrets.store(SECRET_KEY, apiKey.trim());
        void vscode.window.showInformationMessage("NanoGPT API key saved.");
      } else {
        await context.secrets.delete(SECRET_KEY);
        void vscode.window.showInformationMessage("NanoGPT API key cleared.");
      }
      provider.clearModelCache();
    }),
    vscode.commands.registerCommand("nanogpt.refreshModels", () => {
      provider.clearModelCache();
      void vscode.window.showInformationMessage("NanoGPT model cache cleared.");
    }),
  );
}

export function deactivate(): void {}
