import * as vscode from "vscode";
import {
  type NanoGptReasoningEffort,
  type NanoGptReasoningOutput,
  type NanoGptRoutingMode,
  type NanoGptToolCallingStrategy,
  type VscodeModelMetadata,
} from "./nanogpt.js";
import { DEFAULT_MODELS } from "./default-models.js";

export const SECRET_KEY = "nanogpt.apiKey";
export const VERBOSE_LOGGING_SETTING = "verboseLogging";

export { DEFAULT_MODELS };

export type ProviderConfiguration = {
  apiKey?: string;
  routingMode?: string;
  provider?: string;
  models?: unknown[];
  reasoningEffort?: string;
  reasoningOutput?: string;
  toolCallingStrategy?: string;
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
  return getReasoningEffortWithStatus(providerConfiguration, modelOptions).value;
}

/**
 * Internal resolution result used to surface configuration typos. The
 * `invalidValue` field is set only when the user configured a non-empty,
 * non-`auto` value that is not one of the six valid NanoGPT effort levels.
 * Callers that have a logger should warn once per invalid value.
 */
type ReasoningEffortResolution = {
  value: NanoGptReasoningEffort | undefined;
  invalidValue?: string;
};

const VALID_REASONING_EFFORTS: readonly NanoGptReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export function getReasoningEffortWithStatus(
  providerConfiguration?: ProviderConfiguration,
  modelOptions?: { readonly [name: string]: unknown },
): ReasoningEffortResolution {
  const value =
    typeof modelOptions?.reasoningEffort === "string"
      ? modelOptions.reasoningEffort
      : typeof providerConfiguration?.reasoningEffort === "string"
        ? providerConfiguration.reasoningEffort
        : getConfig().get<string>("reasoningEffort", "auto");

  if (value === "auto" || value === undefined) {
    return { value: undefined };
  }

  if (VALID_REASONING_EFFORTS.includes(value as NanoGptReasoningEffort)) {
    return { value: value as NanoGptReasoningEffort };
  }

  return { value: undefined, invalidValue: String(value) };
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
  return getReasoningOutputWithStatus(providerConfiguration, modelOptions).value;
}

type ReasoningOutputResolution = {
  value: NanoGptReasoningOutput;
  invalidValue?: string;
};

const VALID_REASONING_OUTPUTS: readonly NanoGptReasoningOutput[] = [
  "hidden",
  "visible",
  "native",
];

export function getReasoningOutputWithStatus(
  providerConfiguration?: ProviderConfiguration,
  modelOptions?: { readonly [name: string]: unknown },
): ReasoningOutputResolution {
  const value =
    typeof modelOptions?.reasoningOutput === "string"
      ? modelOptions.reasoningOutput
      : typeof providerConfiguration?.reasoningOutput === "string"
        ? providerConfiguration.reasoningOutput
        : getConfig().get<string>("reasoningOutput", "native");

  if (VALID_REASONING_OUTPUTS.includes(value as NanoGptReasoningOutput)) {
    return { value: value as NanoGptReasoningOutput };
  }

  return { value: "native", invalidValue: typeof value === "string" && value ? value : String(value) };
}

/**
 * Resolves the tool-calling strategy from model options, provider
 * configuration, or workspace settings. Defaults to `"native"`.
 */
export function getToolCallingStrategy(
  providerConfiguration?: ProviderConfiguration,
  modelOptions?: { readonly [name: string]: unknown },
): NanoGptToolCallingStrategy {
  return getToolCallingStrategyWithStatus(providerConfiguration, modelOptions).value;
}

type ToolCallingStrategyResolution = {
  value: NanoGptToolCallingStrategy;
  invalidValue?: string;
};

const VALID_TOOL_CALLING_STRATEGIES: readonly NanoGptToolCallingStrategy[] = [
  "native",
  "auto",
  "bridge",
];

export function getToolCallingStrategyWithStatus(
  providerConfiguration?: ProviderConfiguration,
  modelOptions?: { readonly [name: string]: unknown },
): ToolCallingStrategyResolution {
  const value =
    typeof modelOptions?.toolCallingStrategy === "string"
      ? modelOptions.toolCallingStrategy
      : typeof providerConfiguration?.toolCallingStrategy === "string"
          ? providerConfiguration.toolCallingStrategy
          : getConfig().get<string>("toolCallingStrategy", "native");

  if (VALID_TOOL_CALLING_STRATEGIES.includes(value as NanoGptToolCallingStrategy)) {
    return { value: value as NanoGptToolCallingStrategy };
  }

  return { value: "native", invalidValue: typeof value === "string" && value ? value : String(value) };
}

/**
 * Runtime type-narrower for the VS Code provider configuration payload.
 * Returns a typed {@link ProviderConfiguration} when every present field
 * has the expected type; returns `undefined` when the payload is
 * structurally invalid (e.g. `models` is not an array, `routingMode` is
 * a number).  Absent fields are simply omitted from the result.
 *
 * Call this at the boundary where VS Code hands the extension a raw
 * provider configuration object so that downstream resolvers receive a
 * validated shape.  A `undefined` return means the caller should treat
 * the payload as if no provider configuration was supplied and log a
 * warning.
 */
export function parseProviderConfiguration(
  input: unknown,
): ProviderConfiguration | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }

  const raw = input as Record<string, unknown>;
  const result: ProviderConfiguration = {};

  for (const key of ["apiKey", "routingMode", "provider", "reasoningEffort", "reasoningOutput", "toolCallingStrategy"] as const) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      return undefined;
    }
    result[key] = value;
  }

  if ("models" in raw) {
    const models = raw.models;
    if (models !== undefined) {
      if (!Array.isArray(models)) {
        return undefined;
      }
      result.models = models as unknown[];
    }
  }

  return result;
}

/**
 * Options that control how `resolveApiKey` searches for credentials.
 *
 * `allowInsecureSources` is reserved for explicit opt-in contexts such as
 * a developer enabling `untrustedWorkspaces.supported: true` in the future.
 * When `false` (the default), only per-model provider configuration and
 * VS Code secret storage are consulted. Falling back to workspace
 * settings or environment variables is intentionally disabled because
 * those sources can be synced to other machines, committed by accident,
 * or leaked into child-process environments.
 */
export type ResolveApiKeyOptions = {
  allowInsecureSources?: boolean;
};

/**
 * Resolves the NanoGPT API key from safe sources, in order of priority:
 *
 * 1. Per-model provider configuration (from Chat: Manage Language Models).
 * 2. VS Code secret storage (set via NanoGPT: Manage API Key command).
 *
 * The previous implementation also consulted `nanogpt.apiKey` from
 * workspace settings and the `NANOGPT_API_KEY` environment variable.
 * Those fallbacks were removed because workspace settings can be synced
 * or accidentally committed, and process environment values are
 * inherited by every subprocess the user opens from VS Code. To opt
 * back into the legacy fallback chain, pass
 * `{ allowInsecureSources: true }`.
 */
export async function resolveApiKey(
  context: vscode.ExtensionContext,
  providerConfiguration?: ProviderConfiguration,
  options?: ResolveApiKeyOptions,
): Promise<string | undefined> {
  const fromConfiguration =
    typeof providerConfiguration?.apiKey === "string"
      ? providerConfiguration.apiKey.trim()
      : "";

  if (fromConfiguration) {
    return fromConfiguration;
  }

  const fromSecrets = (await context.secrets.get(SECRET_KEY))?.trim();
  if (fromSecrets) {
    return fromSecrets;
  }

  if (!options?.allowInsecureSources) {
    return undefined;
  }

  const fromWorkspaceSettings = getConfig().get<string>("apiKey", "").trim();
  if (fromWorkspaceSettings) {
    return fromWorkspaceSettings;
  }

  return process.env.NANOGPT_API_KEY?.trim() || undefined;
}
