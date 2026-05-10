import * as vscode from "vscode";
import {
  buildModelConfigurationSchema,
  type NanoGptReasoningEffort,
  type NanoGptReasoningOutput,
  type NanoGptRoutingMode,
  type NanoGptToolCallingStrategy,
  type VscodeModelMetadata,
} from "./nanogpt.js";

export const SECRET_KEY = "nanogpt.apiKey";
export const VERBOSE_LOGGING_SETTING = "verboseLogging";

export const DEFAULT_MODELS: VscodeModelMetadata[] = [
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    family: "gpt-5.4-mini",
    version: "gpt-5.4-mini",
    maxInputTokens: 167232,
    maxOutputTokens: 32768,
    detail: "NanoGPT",
    tooltip: "NanoGPT model gpt-5.4-mini",
    capabilities: {
      imageInput: true,
      toolCalling: false,
      family: "gpt-5.4-mini",
      tokenizer: "o200k_base",
    },
    reasoning: true,
    internal: {
      parallelToolCalls: false,
    },
    configurationSchema: buildModelConfigurationSchema(),
  },
];

export type ProviderConfiguration = {
  apiKey?: unknown;
  routingMode?: unknown;
  provider?: unknown;
  models?: unknown;
  reasoningEffort?: unknown;
  reasoningOutput?: unknown;
  toolCallingStrategy?: unknown;
};

// ── Configuration helpers ────────────────────────────────────────────────────

/**
 * Returns the `nanogpt` workspace configuration section.
 */
function getConfig() {
  return vscode.workspace.getConfiguration("nanogpt");
}

export function isVerboseLoggingEnabled(): boolean {
  return getConfig().get<boolean>(VERBOSE_LOGGING_SETTING, false);
}

/**
 * Resolves the NanoGPT routing mode from provider configuration or
 * workspace settings. Defaults to `"subscription"`.
 */
export function getRoutingMode(providerConfiguration?: ProviderConfiguration): NanoGptRoutingMode {
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
export function getProvider(providerConfiguration?: ProviderConfiguration): string {
  return typeof providerConfiguration?.provider === "string"
    ? providerConfiguration.provider
    : getConfig().get<string>("provider", "");
}

/**
 * Resolves the model allowlist from provider configuration or workspace
 * settings. Returns an empty array when no allowlist is configured.
 */
export function getModelAllowlist(providerConfiguration?: ProviderConfiguration): string[] {
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
export function getReasoningEffort(
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

  if (value === "auto" || value === undefined) {
    return undefined;
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
export function getReasoningOutput(
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
 * Resolves the tool-calling strategy from model options, provider
 * configuration, or workspace settings. Defaults to `"auto"`.
 */
export function getToolCallingStrategy(
  providerConfiguration?: ProviderConfiguration,
  modelOptions?: { readonly [name: string]: unknown },
): NanoGptToolCallingStrategy {
  const value =
    typeof modelOptions?.toolCallingStrategy === "string"
      ? modelOptions.toolCallingStrategy
      : typeof providerConfiguration?.toolCallingStrategy === "string"
          ? providerConfiguration.toolCallingStrategy
          : getConfig().get<string>("toolCallingStrategy", "auto");

        return value === "auto" || value === "bridge" || value === "native" ? value : "auto";
}

/**
 * Resolves the NanoGPT API key from available sources, in order of priority:
 * 1. Per-model provider configuration (from Chat: Manage Language Models)
 * 2. VS Code secret storage (set via NanoGPT: Manage API Key command)
 * 3. VS Code settings (nanogpt.apiKey — avoid checking this into Git)
 * 4. Environment variable NANOGPT_API_KEY (use with caution in dev-only contexts)
 */
export async function resolveApiKey(
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
