import * as vscode from "vscode";
import { NanoGptClient, type NanoGptLogger } from "./client.js";
import { estimateTokenCount, toNanoGptMessages, type VscodeModelMetadata } from "./nanogpt.js";
import {
  DEFAULT_MODELS,
  getModelAllowlist,
  getProvider,
  getReasoningEffort,
  getReasoningOutput,
  getRoutingMode,
  getToolCallingStrategy,
  isVerboseLoggingEnabled,
  resolveApiKey,
  SECRET_KEY,
  VERBOSE_LOGGING_SETTING,
  type ProviderConfiguration,
} from "./config.js";
import { createLogger, OUTPUT_CHANNEL_NAME } from "./logging.js";
import { toCoreMessages, toToolMode, createThinkingPart } from "./vscode-messaging.js";
import { formatKeyValuePairs, formatRoleCounts, formatError, isObject, sha256Hex } from "./utils.js";

const VENDOR_ID = "nanogpt";

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

type MessageSummary = {
  messageCount: number;
  roleCounts: Record<string, number>;
  textParts: number;
  dataParts: number;
  toolCallParts: number;
  toolResultParts: number;
};

type RuntimeLanguageModelLike = vscode.LanguageModelChat & {
  vendor?: unknown;
  tokenizer?: unknown;
  capabilities?: unknown;
};

function summarizeMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): MessageSummary {
  const summary: MessageSummary = {
    messageCount: messages.length,
    roleCounts: {},
    textParts: 0,
    dataParts: 0,
    toolCallParts: 0,
    toolResultParts: 0,
  };

  for (const message of messages) {
    const role = String(message.role);
    summary.roleCounts[role] = (summary.roleCounts[role] ?? 0) + 1;

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        summary.textParts += 1;
        continue;
      }

      if (part instanceof vscode.LanguageModelDataPart) {
        summary.dataParts += 1;
        continue;
      }

      if (part instanceof vscode.LanguageModelToolCallPart) {
        summary.toolCallParts += 1;
        continue;
      }

      if (part instanceof vscode.LanguageModelToolResultPart) {
        summary.toolResultParts += 1;
      }
    }
  }

  return summary;
}

function summarizeTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): string {
  if (!tools || tools.length === 0) {
    return "count=0";
  }

  return formatKeyValuePairs({
    count: tools.length,
    names: tools.map((tool) => tool.name).join("|") || "none",
  });
}

function getRuntimeCapabilities(
  model: RuntimeLanguageModelLike,
): Record<string, unknown> | undefined {
  return isObject(model.capabilities) ? model.capabilities : undefined;
}

function createModelCacheKey(
  apiKey: string,
  routingMode: string,
  allowlistKey?: string,
): string {
  const key = `${routingMode}:${sha256Hex(apiKey)}`;
  return allowlistKey ? `${key}:${allowlistKey}` : key;
}

function getRuntimeCapabilityValue(model: RuntimeLanguageModelLike, key: string): string {
  const capabilities = getRuntimeCapabilities(model);
  if (!capabilities) {
    return "undefined";
  }

  const value = capabilities[key];
  return value === undefined ? "undefined" : String(value);
}

function summarizeRuntimeModel(model: RuntimeLanguageModelLike): string {
  const capabilities = getRuntimeCapabilities(model);
  const capabilityKeys = capabilities ? Object.keys(capabilities).join("|") || "none" : "none";

  return formatKeyValuePairs({
    id: model.id,
    vendor: typeof model.vendor === "string" ? model.vendor : "unknown",
    family: model.family,
    version: model.version,
    tokenizer: model.tokenizer === undefined ? "undefined" : String(model.tokenizer),
    capabilityKeys,
    capabilityFamily: getRuntimeCapabilityValue(model, "family"),
    capabilityTokenizer: getRuntimeCapabilityValue(model, "tokenizer"),
  });
}

async function logRuntimeModelResolution(logger: NanoGptLogger): Promise<void> {
  try {
    const models = await vscode.lm.selectChatModels({ vendor: VENDOR_ID });
    logger.debug(`[runtime] resolved NanoGPT models (${formatKeyValuePairs({ count: models.length })})`);

    for (const model of models.slice(0, 5)) {
      let helloTokenCount = "error";

      try {
        helloTokenCount = String(await model.countTokens("hello"));
      } catch (error) {
        helloTokenCount = `error:${formatError(error)}`;
      }

      logger.debug(
        `[runtime] selected model (${summarizeRuntimeModel(model as RuntimeLanguageModelLike)}, helloTokens=${helloTokenCount})`,
      );
    }
  } catch (error) {
    logger.warn(`[runtime] failed to resolve NanoGPT models: ${formatError(error)}`);
  }
}

/**
 * Creates an `AbortSignal` that mirrors the VS Code cancellation token.
 * Aborts immediately if the token is already cancelled.
 */
function createAbortSignal(token: vscode.CancellationToken): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  }
  const disposable = token.onCancellationRequested(() => controller.abort());
  return {
    signal: controller.signal,
    dispose: () => disposable.dispose(),
  };
}

/**
 * VS Code Language Model Chat Provider backed by NanoGPT.
 *
 * Implements the {@link ChatProviderApi} interface to:
 * - Discover models from the NanoGPT API (or serve a fallback).
 * - Stream chat completions and map responses to VS Code parts.
 * - Provide approximate token counts.
 */
export class NanoGptLanguageModelProvider implements ChatProviderApi {
  /**
  * Cache keyed on `routingMode + sha256(apiKey)` so that different API keys
  * or routing surfaces each get an independent cached model list without
  * retaining raw credentials in memory keys.
   * `clearModelCache()` flushes all entries.
   */
  private readonly modelCache = new Map<string, VscodeModelMetadata[]>();
  private readonly modelChangeEmitter = new vscode.EventEmitter<void>();
  private nextRequestNumber = 0;
  readonly onDidChangeLanguageModelChatInformation = this.modelChangeEmitter.event;
  private static readonly onboardingWarningMessage =
    "NanoGPT API key is required to discover models. You can manage provider settings or enter a key directly.";
  private static readonly openManageLanguageModelsAction = "Open Manage Language Models";
  private static readonly manageApiKeyDirectlyAction = "Manage API Key Directly";
  // Known runtime command IDs that should be preferred when available.
  // Runtime probing is still authoritative, so this list is intentionally small.
  private static readonly preferredLanguageModelManagementCommands = [
    "workbench.action.chat.manageModels",
    "workbench.action.chat.manageLanguageModels",
  ];
  private static readonly runtimeLanguageModelManagementCommandPattern =
    /manage(?:LanguageModels|LanguageModel|Models|Model)/i;
  private static readonly runtimeLanguageModelManagementCommandBlacklist = [
    /openchat/i,
    /\bopen\b.*\bchat\b/i,
  ];
  private hasShownMissingApiKeyWarningThisSession = false;

  /**
   * @param context - VS Code extension context for secret storage.
   * @param client  - The NanoGPT HTTP client instance.
   * @param logger  - The provider logger instance.
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: NanoGptClient,
    private readonly logger: NanoGptLogger,
  ) {}

  private notifyModelCatalogChanged(reason: string): void {
    this.logger.info(`[provider] model catalog changed (${formatKeyValuePairs({ reason })})`);
    this.modelChangeEmitter.fire();
  }

  private nextRequestId(kind: "discovery" | "chat"): string {
    this.nextRequestNumber += 1;
    return `${kind}-${this.nextRequestNumber}`;
  }

  private static isPlausibleLanguageModelManagementCommand(command: string): boolean {
    const normalized = String(command).trim();
    if (normalized.length === 0) {
      return false;
    }

    const blacklisted = NanoGptLanguageModelProvider.runtimeLanguageModelManagementCommandBlacklist.some((pattern) =>
      pattern.test(normalized),
    );
    if (blacklisted) {
      return false;
    }

    return NanoGptLanguageModelProvider.runtimeLanguageModelManagementCommandPattern.test(normalized);
  }

  private async probeLanguageModelManagementCommand(): Promise<string | undefined> {
    try {
      const commands = await vscode.commands.getCommands(true);
      for (const candidate of NanoGptLanguageModelProvider.preferredLanguageModelManagementCommands) {
        if (commands.includes(candidate)) {
          return candidate;
        }
      }

      for (const command of commands) {
        if (NanoGptLanguageModelProvider.isPlausibleLanguageModelManagementCommand(command)) {
          return command;
        }
      }
    } catch {
      // If runtime command enumeration fails, fall back to the hard-coded command.
    }
    return undefined;
  }

  private async openLanguageModelManagementCommand(): Promise<void> {
    const command = await this.probeLanguageModelManagementCommand();
    if (command) {
      try {
        await vscode.commands.executeCommand(command);
        return;
      } catch {
        // Fall through to the fallback command.
      }
    }
    await vscode.commands.executeCommand("nanogpt.manage");
  }

  private async handleMissingApiKeyOnboarding(silent: boolean): Promise<void> {
    if (silent) {
      if (this.hasShownMissingApiKeyWarningThisSession) {
        return;
      }
      this.hasShownMissingApiKeyWarningThisSession = true;
      void vscode.window.showWarningMessage(NanoGptLanguageModelProvider.onboardingWarningMessage);
      return;
    }

    const action = await vscode.window.showWarningMessage(
      NanoGptLanguageModelProvider.onboardingWarningMessage,
      NanoGptLanguageModelProvider.openManageLanguageModelsAction,
      NanoGptLanguageModelProvider.manageApiKeyDirectlyAction,
    );

    if (action === NanoGptLanguageModelProvider.openManageLanguageModelsAction) {
      await this.openLanguageModelManagementCommand();
      return;
    }

    if (action === NanoGptLanguageModelProvider.manageApiKeyDirectlyAction) {
      await vscode.commands.executeCommand("nanogpt.manage");
    }
  }

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
    if (!options.configuration) {
      // VS Code automatically creates and queries a default configured instance based on the
      // package.json languageModelChatProviders contribution. Returning models for the legacy
      // global unconfigured provider would result in duplicates.
      return [];
    }

    const requestId = this.nextRequestId("discovery");
    const startedAt = Date.now();
    const apiKey = await resolveApiKey(this.context, options.configuration);
    const allowlist = getModelAllowlist(options.configuration);
    const routingMode = getRoutingMode(options.configuration);
    const allowlistKey = allowlist.length > 0
      ? allowlist.slice().sort().join(",")
      : undefined;

    this.logger.info(`[${requestId}] model discovery started`);
    this.logger.debug(
      `[${requestId}] model discovery parameters (${formatKeyValuePairs({
        silent: options.silent,
        routingMode,
        hasApiKey: Boolean(apiKey),
        allowlistCount: allowlist.length,
      })})`,
    );

    if (allowlist.length > 0 && !apiKey) {
      this.logger.warn(
        `[${requestId}] model discovery returned allowlist fallback (${formatKeyValuePairs({
          allowlistCount: allowlist.length,
          durationMs: Date.now() - startedAt,
        })})`,
      );
      await this.handleMissingApiKeyOnboarding(options.silent);
      // No API key — return capability stubs for the allowlisted IDs.
      // Use safe pessimistic defaults rather than cloning DEFAULT_MODELS[0] so
      // that capabilities like imageInput and toolCalling are not incorrectly
      // advertised for unverified models.
      return allowlist.map((id) => ({
        ...DEFAULT_MODELS[0],
        id,
        name: id,
        family: id,
        version: id,
        detail: "NanoGPT (unverified)",
        tooltip: `NanoGPT model ${id} (unverified)`,
        capabilities: {
          imageInput: false,
          toolCalling: false,
          family: id,
          tokenizer: "o200k_base",
        },
        reasoning: false,
        internal: {
          parallelToolCalls: false,
        },
      }));
    }

    if (!apiKey) {
      this.logger.warn(
        `[${requestId}] model discovery missing API key; returning fallback models (${formatKeyValuePairs({
          silent: options.silent,
          routingMode,
          durationMs: Date.now() - startedAt,
        })})`,
      );
      await this.handleMissingApiKeyOnboarding(options.silent);
      return DEFAULT_MODELS;
    }

    const cacheKey = createModelCacheKey(apiKey, routingMode, allowlistKey);
    const abortSignal = createAbortSignal(token);
    try {
      const models = await this.client.discoverModels({
        apiKey,
        routingMode,
        allowlist: allowlist.length > 0 ? allowlist : undefined,
        signal: abortSignal.signal,
        requestId,
      });
      const result = models.length > 0 ? models : DEFAULT_MODELS;
      this.modelCache.set(cacheKey, result);
      this.logger.info(
        `[${requestId}] model discovery completed (${formatKeyValuePairs({
          returnedModels: result.length,
          durationMs: Date.now() - startedAt,
        })})`,
      );
      this.logger.debug(
        `[${requestId}] model discovery result details (${formatKeyValuePairs({
          routingMode,
          discoveredModels: models.length,
          cacheKeyReused: false,
        })})`,
      );
      return result;
    } catch (err) {
      const fallback = this.modelCache.get(cacheKey) ?? DEFAULT_MODELS;
      this.logger.error(
        `[${requestId}] model discovery failed (${formatKeyValuePairs({
          routingMode,
          fallbackModels: fallback.length,
          durationMs: Date.now() - startedAt,
        })}): ${formatError(err)}`,
      );
      if (!options.silent) {
        void vscode.window.showWarningMessage(
          `NanoGPT model discovery failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return fallback;
    } finally {
      abortSignal.dispose();
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
    const requestId = this.nextRequestId("chat");
    const startedAt = Date.now();
    const apiKey = await resolveApiKey(this.context, options.configuration);
    if (!apiKey) {
      this.logger.warn(`[${requestId}] chat request blocked: API key is not configured`);
      throw new vscode.LanguageModelError("NanoGPT API key is not configured");
    }

    const reasoningOutput = getReasoningOutput(options.configuration, options.modelOptions);
    const reasoningEffort = getReasoningEffort(options.configuration, options.modelOptions);
    const toolCallingStrategy = getToolCallingStrategy(options.configuration, options.modelOptions);
    const routingMode = getRoutingMode(options.configuration);
    const provider = getProvider(options.configuration);
    const toolMode =
      options.toolMode === vscode.LanguageModelChatToolMode.Required
        ? "required"
        : options.toolMode === vscode.LanguageModelChatToolMode.Auto
          ? "auto"
          : "default";
    const messageSummary = summarizeMessages(messages);
    const responseSummary = {
      textDeltas: 0,
      textChars: 0,
      reasoningDeltas: 0,
      reasoningChars: 0,
      toolCalls: 0,
    };

    this.logger.info(
      `[${requestId}] chat request started (${formatKeyValuePairs({
        model: model.id,
        routingMode,
        messageCount: messageSummary.messageCount,
      })})`,
    );
    this.logger.debug(
      `[${requestId}] chat request started (${formatKeyValuePairs({
        provider,
        maxTokens: options.modelOptions?.maxTokens ?? "default",
        toolMode,
        reasoningEffort: reasoningEffort ?? "auto",
        reasoningOutput,
        toolCallingStrategy,
        parallelToolCalls: Boolean(model.internal?.parallelToolCalls),
        messageCount: messageSummary.messageCount,
        roles: formatRoleCounts(messageSummary.roleCounts),
        textParts: messageSummary.textParts,
        dataParts: messageSummary.dataParts,
        toolCallParts: messageSummary.toolCallParts,
        toolResultParts: messageSummary.toolResultParts,
      })}; tools(${summarizeTools(options.tools)})`,
    );

    const abortSignal = createAbortSignal(token);

    try {
      const result = await this.client.streamChatCompletions({
        apiKey,
        modelId: model.id,
        messages: toNanoGptMessages(toCoreMessages(messages)),
        routingMode,
        provider,
        maxTokens: options.modelOptions?.maxTokens,
        tools: options.tools,
        toolMode: toToolMode(options.toolMode),
        reasoningEffort,
        reasoningOutput,
        toolCallingStrategy,
        parallelToolCalls: model.internal?.parallelToolCalls,
        signal: abortSignal.signal,
        requestId,
        onText: (text) => {
          responseSummary.textDeltas += 1;
          responseSummary.textChars += text.length;
          progress.report(new vscode.LanguageModelTextPart(text));
        },
        onReasoning: (text) => {
          responseSummary.reasoningDeltas += 1;
          responseSummary.reasoningChars += text.length;
          if (reasoningOutput === "hidden") {
            return;
          }
          const thinkingPart = createThinkingPart(text);
          if (thinkingPart) {
            progress.report(thinkingPart);
          } else if (reasoningOutput === "visible") {
            progress.report(new vscode.LanguageModelTextPart(text));
          }
        },
        onToolCall: (toolCall) => {
          responseSummary.toolCalls += 1;
          progress.report(
            new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input),
          );
        },
      });

      if (result.requiredToolWarning) {
        responseSummary.textDeltas += 1;
        responseSummary.textChars += result.requiredToolWarning.length;
        progress.report(new vscode.LanguageModelTextPart(result.requiredToolWarning));
      }

      const rawBridgeTelemetry =
        typeof result?.bridgeTelemetry === "object" && result.bridgeTelemetry !== null
          ? result.bridgeTelemetry
          : {};
      const bridgeTelemetry = {
        bridgeRepairAttempts: 0,
        bridgeRepairSuccesses: 0,
        bridgeRawTextFallbacks: 0,
        bridgeRequiredFailClosed: 0,
        ...rawBridgeTelemetry,
      };

      this.logger.info(
        `[${requestId}] chat request completed (${formatKeyValuePairs({
          durationMs: Date.now() - startedAt,
          textDeltas: responseSummary.textDeltas,
          reasoningDeltas: responseSummary.reasoningDeltas,
          toolCalls: responseSummary.toolCalls,
        })})`,
      );
      this.logger.debug(
        `[${requestId}] chat request result details (${formatKeyValuePairs({
          textChars: responseSummary.textChars,
          reasoningChars: responseSummary.reasoningChars,
          bridgeRepairAttempts: bridgeTelemetry.bridgeRepairAttempts,
          bridgeRepairSuccesses: bridgeTelemetry.bridgeRepairSuccesses,
          bridgeRawTextFallbacks: bridgeTelemetry.bridgeRawTextFallbacks,
          bridgeRequiredFailClosed: bridgeTelemetry.bridgeRequiredFailClosed,
        })})`,
      );
    } catch (error) {
      this.logger.error(
        `[${requestId}] chat request failed (${formatKeyValuePairs({
          durationMs: Date.now() - startedAt,
          textDeltas: responseSummary.textDeltas,
          reasoningDeltas: responseSummary.reasoningDeltas,
          toolCalls: responseSummary.toolCalls,
        })}): ${formatError(error)}`,
      );
      throw error;
    } finally {
      abortSignal.dispose();
    }
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
  clearModelCache(reason = "cache-cleared"): void {
    this.modelCache.clear();
    this.notifyModelCatalogChanged(reason);
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
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true });
  context.subscriptions.push(output);
  const logger = createLogger(output);

  logger.info("NanoGPT extension activated");
  logger.debug(`NanoGPT verbose logging is ${isVerboseLoggingEnabled() ? "enabled" : "disabled"}`);

  const provider = new NanoGptLanguageModelProvider(context, new NanoGptClient(fetch, logger), logger);
  const lm = vscode.lm as typeof vscode.lm & {
    registerLanguageModelChatProvider?: (
      vendor: string,
      provider: ChatProviderApi,
    ) => vscode.Disposable;
  };

  if (typeof lm.registerLanguageModelChatProvider === "function") {
    context.subscriptions.push(lm.registerLanguageModelChatProvider(VENDOR_ID, provider));
    if (isVerboseLoggingEnabled()) {
      void logRuntimeModelResolution(logger);
    }
  } else {
    logger.warn("Language Model Chat Provider API is unavailable in this VS Code build");
    void vscode.window.showWarningMessage(
      "NanoGPT requires a VS Code build with Language Model Chat Provider support.",
    );
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("nanogpt.apiKey") ||
        event.affectsConfiguration("nanogpt.routingMode") ||
        event.affectsConfiguration("nanogpt.provider") ||
        event.affectsConfiguration("nanogpt.models")
      ) {
        provider.clearModelCache("configuration-changed");
      }

      if (event.affectsConfiguration(`nanogpt.${VERBOSE_LOGGING_SETTING}`)) {
        const verboseLoggingEnabled = isVerboseLoggingEnabled();
        logger.info(`NanoGPT verbose logging ${verboseLoggingEnabled ? "enabled" : "disabled"}`);
        if (verboseLoggingEnabled) {
          void logRuntimeModelResolution(logger);
        }
      }
    }),
    vscode.commands.registerCommand("nanogpt.manage", async () => {
      logger.debug("Manage API key command invoked");
      const apiKey = await vscode.window.showInputBox({
        title: "NanoGPT API key",
        prompt: "Enter a NanoGPT API key",
        password: true,
        ignoreFocusOut: true,
      });
      if (apiKey === undefined) {
        logger.debug("Manage API key command cancelled");
        return;
      }

      if (apiKey.trim()) {
        await context.secrets.store(SECRET_KEY, apiKey.trim());
        logger.info("NanoGPT API key saved to VS Code secret storage");
        void vscode.window.showInformationMessage("NanoGPT API key saved.");
      } else {
        await context.secrets.delete(SECRET_KEY);
        logger.info("NanoGPT API key cleared from VS Code secret storage");
        void vscode.window.showInformationMessage("NanoGPT API key cleared.");
      }
      provider.clearModelCache("api-key-updated");
      logger.debug("NanoGPT model cache cleared after API key update");
    }),
    vscode.commands.registerCommand("nanogpt.refreshModels", () => {
      provider.clearModelCache("manual-refresh");
      logger.info("NanoGPT model cache cleared by refresh command");
      void vscode.window.showInformationMessage("NanoGPT model cache cleared.");
    }),
  );
}

/** No-op deactivation hook. */
export function deactivate(): void {}
