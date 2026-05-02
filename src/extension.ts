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

/**
 * Returns the `nanogpt` workspace configuration section.
 */
function getConfig() {
  return vscode.workspace.getConfiguration("nanogpt");
}

/**
 * Resolves the NanoGPT routing mode from provider configuration or
 * workspace settings. Defaults to `"subscription"`.
 */
function getRoutingMode(providerConfiguration?: ProviderConfiguration): NanoGptRoutingMode {
  const value =
    typeof providerConfiguration?.routingMode === "string"
      ? providerConfiguration.routingMode
      : getConfig().get<string>("routingMode", "subscription");
  return value === "paygo" ? "paygo" : "subscription";
}

/**
 * Resolves the optional upstream provider ID from provider configuration
 * or workspace settings. Returns an empty string when not configured.
 */
function getProvider(providerConfiguration?: ProviderConfiguration): string {
  return typeof providerConfiguration?.provider === "string"
    ? providerConfiguration.provider
    : getConfig().get<string>("provider", "");
}

/**
 * Resolves the model allowlist from provider configuration or workspace
 * settings. Returns an empty array when no allowlist is configured.
 */
function getModelAllowlist(providerConfiguration?: ProviderConfiguration): string[] {
  if (Array.isArray(providerConfiguration?.models)) {
    return providerConfiguration.models.filter((model): model is string => typeof model === "string");
  }

  return getConfig().get<string[]>("models", []);
}

/**
 * Resolves the reasoning effort from model options, provider configuration,
 * or workspace settings. Validates against the known NanoGPT effort values.
 * Returns `undefined` when the configured value is invalid or unrecognised.
 */
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

/**
 * Resolves the reasoning output mode from model options, provider
 * configuration, or workspace settings. Validates against `"hidden"`,
 * `"visible"`, and `"native"`; defaults to `"native"` when unrecognised.
 */
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

/**
 * Resolves the NanoGPT API key from available sources, in order of priority:
 * 1. Per-model provider configuration (from Chat: Manage Language Models)
 * 2. VS Code secret storage (set via NanoGPT: Manage API Key command)
 * 3. VS Code settings (nanogpt.apiKey — avoid checking this into Git)
 * 4. Environment variable NANOGPT_API_KEY (use with caution in dev-only contexts)
 */
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

/**
 * Creates an `AbortSignal` that mirrors the VS Code cancellation token.
 * Aborts immediately if the token is already cancelled.
 */
function createAbortSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  }
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

/**
 * Converts VS Code's typed chat message parts into the generic
 * `VscodeLikePart` shape expected by {@link toNanoGptMessages}.
 */
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

/**
 * Maps the VS Code `LanguageModelChatToolMode` enum to the NanoGPT
 * tool-mode string (`"auto"` | `"required"`). Returns `undefined`
 * when no mode is configured.
 */
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

/**
 * Creates a VS Code `LanguageModelThinkingPart` when the API is available
 * in the current VS Code build. Returns `undefined` on older builds that
 * lack thinking part support, allowing fallback to text-based reasoning.
 */
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

/**
 * VS Code Language Model Chat Provider backed by NanoGPT.
 *
 * Implements the {@link ChatProviderApi} interface to:
 * - Discover models from the NanoGPT API (or serve a fallback).
 * - Stream chat completions and map responses to VS Code parts.
 * - Provide approximate token counts.
 */
class NanoGptLanguageModelProvider implements ChatProviderApi {
  /**
   * Cache keyed on `"${apiKey}|${routingMode}"` so that different API keys
   * or routing surfaces each get an independent cached model list.
   * `clearModelCache()` flushes all entries.
   */
  private readonly modelCache = new Map<string, VscodeModelMetadata[]>();

  /**
   * @param context - VS Code extension context for secret storage.
   * @param client  - The NanoGPT HTTP client instance.
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: NanoGptClient,
  ) {}

  /**
   * Provides the list of available NanoGPT models to VS Code.
   *
   * - When both an API key and an allowlist are configured, discovers models
   *   from NanoGPT and filters the result to the allowlisted IDs so that
   *   accurate capability metadata is returned.
   * - When an allowlist is configured but no API key is available, returns
   *   capability stubs for the allowlisted IDs as a fallback.
   * - Falls back to DEFAULT_MODELS when no API key is configured.
   * - Caches discovered results per `apiKey + routingMode` and falls back to
   *   the per-key cache on discovery failure.
   */
  async provideLanguageModelChatInformation(
    options: { silent: boolean; configuration?: ProviderConfiguration },
    token: vscode.CancellationToken,
  ): Promise<VscodeModelMetadata[]> {
    const apiKey = await resolveApiKey(this.context, options.configuration);
    const allowlist = getModelAllowlist(options.configuration);
    const routingMode = getRoutingMode(options.configuration);

    if (allowlist.length > 0 && !apiKey) {
      // No API key — return capability stubs for the allowlisted IDs.
      return allowlist.map((id) => ({
        ...DEFAULT_MODELS[0],
        id,
        name: id,
        tooltip: `NanoGPT model ${id}`,
      }));
    }

    if (!apiKey) {
      if (!options.silent) {
        await vscode.commands.executeCommand("nanogpt.manage");
      }
      return this.modelCache.get(`|${routingMode}`) ?? DEFAULT_MODELS;
    }

    const cacheKey = `${apiKey}|${routingMode}`;
    try {
      const models = await this.client.discoverModels({
        apiKey,
        routingMode,
        allowlist: allowlist.length > 0 ? allowlist : undefined,
        signal: createAbortSignal(token),
      });
      const result = models.length > 0 ? models : DEFAULT_MODELS;
      this.modelCache.set(cacheKey, result);
      return result;
    } catch (err) {
      if (!options.silent) {
        void vscode.window.showWarningMessage(
          `NanoGPT model discovery failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return this.modelCache.get(cacheKey) ?? DEFAULT_MODELS;
    }
  }

  /**
   * Streams a chat completion response from NanoGPT and reports
   * progress parts to VS Code.
   *
   * - Text deltas → `LanguageModelTextPart`.
   * - Reasoning deltas → `LanguageModelThinkingPart` (when available)
   *   or `LanguageModelTextPart` (when reasoning output is `visible`).
   * - Tool calls → `LanguageModelToolCallPart`.
   *
   * @throws `LanguageModelError` when no API key is configured.
   */
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

  /**
   * Estimates the token count for a text string or chat request message.
   * Uses a rough character-count heuristic; not model-accurate.
   */
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

  /**
   * Clears the entire model cache so the next discovery call fetches
   * fresh data from NanoGPT for all API keys and routing modes.
   */
  clearModelCache(): void {
    this.modelCache.clear();
  }
}

/**
 * Activates the NanoGPT provider extension.
 *
 * Registers the language model chat provider and the `nanogpt.manage`
 * and `nanogpt.refreshModels` commands. Shows a warning when the VS Code
 * build does not support `registerLanguageModelChatProvider`.
 */
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

/** No-op deactivation hook. */
export function deactivate(): void {}
