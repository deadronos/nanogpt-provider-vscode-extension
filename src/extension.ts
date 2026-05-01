import * as vscode from "vscode";
import { NanoGptClient } from "./client.js";
import {
  buildModelConfigurationSchema,
  estimateTokenCount,
  toNanoGptMessages,
  type NanoGptReasoningEffort,
  type NanoGptReasoningOutput,
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
    reasoning: true,
    configurationSchema: buildModelConfigurationSchema(),
  },
];

type ChatProviderApi = {
  provideLanguageModelChatInformation(
    options: { silent: boolean; configuration?: ProviderConfiguration },
    token: vscode.CancellationToken,
  ): Promise<VscodeModelMetadata[]>;
  provideLanguageModelChatResponse(
    model: VscodeModelMetadata,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: {
      modelOptions?: { maxTokens?: number };
      configuration?: ProviderConfiguration;
      tools?: readonly vscode.LanguageModelChatTool[];
      toolMode?: vscode.LanguageModelChatToolMode;
    },
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void>;
  provideTokenCount(
    model: VscodeModelMetadata,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Promise<number>;
};

type ProviderConfiguration = {
  apiKey?: unknown;
  routingMode?: unknown;
  provider?: unknown;
  models?: unknown;
  reasoningEffort?: unknown;
  reasoningOutput?: unknown;
};

function getConfig() {
  return vscode.workspace.getConfiguration("nanogpt");
}

function getRoutingMode(providerConfiguration?: ProviderConfiguration): NanoGptRoutingMode {
  const value =
    typeof providerConfiguration?.routingMode === "string"
      ? providerConfiguration.routingMode
      : getConfig().get<string>("routingMode", "subscription");
  return value === "paygo" ? "paygo" : "subscription";
}

function getProvider(providerConfiguration?: ProviderConfiguration): string {
  return typeof providerConfiguration?.provider === "string"
    ? providerConfiguration.provider
    : getConfig().get<string>("provider", "");
}

function getModelAllowlist(providerConfiguration?: ProviderConfiguration): string[] {
  if (Array.isArray(providerConfiguration?.models)) {
    return providerConfiguration.models.filter((model): model is string => typeof model === "string");
  }

  return getConfig().get<string[]>("models", []);
}

function getReasoningEffort(
  providerConfiguration?: ProviderConfiguration,
  modelOptions?: { readonly [name: string]: unknown },
): NanoGptReasoningEffort | undefined {
  const value =
    typeof modelOptions?.reasoningEffort === "string"
      ? modelOptions.reasoningEffort
      : typeof providerConfiguration?.reasoningEffort === "string"
        ? providerConfiguration.reasoningEffort
        : getConfig().get<string>("reasoningEffort", "auto");

  const validEfforts: NanoGptReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ];

  if (value === "auto") {
    return "auto";
  }

  return validEfforts.includes(value as NanoGptReasoningEffort)
    ? (value as NanoGptReasoningEffort)
    : undefined;
}

function getReasoningOutput(
  providerConfiguration?: ProviderConfiguration,
  modelOptions?: { readonly [name: string]: unknown },
): NanoGptReasoningOutput {
  const value =
    typeof modelOptions?.reasoningOutput === "string"
      ? modelOptions.reasoningOutput
      : typeof providerConfiguration?.reasoningOutput === "string"
        ? providerConfiguration.reasoningOutput
        : getConfig().get<string>("reasoningOutput", "native");

  return value === "hidden" || value === "visible" || value === "native" ? value : "native";
}

async function resolveApiKey(
  context: vscode.ExtensionContext,
  providerConfiguration?: ProviderConfiguration,
): Promise<string | undefined> {
  return (
    (typeof providerConfiguration?.apiKey === "string" ? providerConfiguration.apiKey.trim() : "") ||
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
      if (part instanceof vscode.LanguageModelToolCallPart) {
        return { callId: part.callId, name: part.name, input: part.input };
      }
      if (part instanceof vscode.LanguageModelToolResultPart) {
        return {
          callId: part.callId,
          content: part.content.map((contentPart) => {
            if (contentPart instanceof vscode.LanguageModelTextPart) {
              return { value: contentPart.value };
            }
            if (contentPart instanceof vscode.LanguageModelDataPart) {
              return { data: contentPart.data, mimeType: contentPart.mimeType };
            }
            return {};
          }),
        };
      }
      return {};
    }),
  }));
}

function toToolMode(
  toolMode: vscode.LanguageModelChatToolMode | undefined,
): "auto" | "required" | undefined {
  if (toolMode === vscode.LanguageModelChatToolMode.Required) {
    return "required";
  }
  if (toolMode === vscode.LanguageModelChatToolMode.Auto) {
    return "auto";
  }
  return undefined;
}

function createThinkingPart(text: string): vscode.LanguageModelResponsePart | undefined {
  const thinkingCtor = (vscode as unknown as {
    LanguageModelThinkingPart?: new (
      value: string | string[],
      id?: string,
      metadata?: { readonly [key: string]: unknown },
    ) => vscode.LanguageModelResponsePart;
  }).LanguageModelThinkingPart;

  return thinkingCtor ? new thinkingCtor(text) : undefined;
}

class NanoGptLanguageModelProvider implements ChatProviderApi {
  private cachedModels: VscodeModelMetadata[] | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: NanoGptClient,
  ) {}

  async provideLanguageModelChatInformation(
    options: { silent: boolean; configuration?: ProviderConfiguration },
    token: vscode.CancellationToken,
  ): Promise<VscodeModelMetadata[]> {
    const apiKey = await resolveApiKey(this.context, options.configuration);
    const allowlist = getModelAllowlist(options.configuration);

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
        routingMode: getRoutingMode(options.configuration),
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
    options: {
      modelOptions?: { maxTokens?: number };
      configuration?: ProviderConfiguration;
      tools?: readonly vscode.LanguageModelChatTool[];
      toolMode?: vscode.LanguageModelChatToolMode;
    },
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const apiKey = await resolveApiKey(this.context, options.configuration);
    if (!apiKey) {
      throw new vscode.LanguageModelError("NanoGPT API key is not configured");
    }

    const reasoningOutput = getReasoningOutput(options.configuration, options.modelOptions);

    await this.client.streamChatCompletions({
      apiKey,
      modelId: model.id,
      messages: toNanoGptMessages(toCoreMessages(messages)),
      routingMode: getRoutingMode(options.configuration),
      provider: getProvider(options.configuration),
      maxTokens: options.modelOptions?.maxTokens,
      tools: options.tools,
      toolMode: toToolMode(options.toolMode),
      reasoningEffort: getReasoningEffort(options.configuration, options.modelOptions),
      reasoningOutput,
      parallelToolCalls: model.internal?.parallelToolCalls,
      signal: createAbortSignal(token),
      onText: (text) => progress.report(new vscode.LanguageModelTextPart(text)),
      onReasoning: (text) => {
        const thinkingPart = createThinkingPart(text);
        if (thinkingPart) {
          progress.report(thinkingPart);
        } else if (reasoningOutput === "visible") {
          progress.report(new vscode.LanguageModelTextPart(text));
        }
      },
      onToolCall: (toolCall) =>
        progress.report(
          new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input),
        ),
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
