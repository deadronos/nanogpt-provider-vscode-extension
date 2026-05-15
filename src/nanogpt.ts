// ── Barrel re-exports from sub-modules ───────────────────────────────────────

export {
  NANOGPT_BASE_URL,
  NANOGPT_SUBSCRIPTION_BASE_URL,
  resolveRole,
} from "./nanogpt-types.js";
export type {
  NanoGptRoutingMode,
  NanoGptMessageRole,
  NanoGptImageUrlContentPart,
  NanoGptTextContentPart,
  NanoGptMessageContent,
  NanoGptToolCall,
  NanoGptToolDefinition,
  NanoGptChatMessage,
  NanoGptToolCallingStrategy,
  VscodeLikePart,
  VscodeLikeMessage,
  NanoGptModelCapabilities,
  NanoGptModelEntry,
  NanoGptReasoningEffort,
  NanoGptReasoningOutput,
  NanoGptTokenizer,
  VscodeModelMetadata,
  VscodeLikeTool,
  NanoGptResponsePart,
  NanoGptRequest,
} from "./nanogpt-types.js";

export {
  toNanoGptMessages,
  toNanoGptTools,
  toNanoGptImagePart,
  toToolCall,
  toToolResultContent,
  getTextPartValue,
} from "./nanogpt-message.js";

export {
  buildToolCallingBridgeMessages,
  buildToolCallingBridgeRepairMessages,
  parseToolCallingBridgeResponse,
} from "./nanogpt-tool-bridge.js";
export type {
  NanoGptBridgeToolCall,
  NanoGptToolBridgeParseResult,
} from "./nanogpt-tool-bridge.js";

export { buildNanoGptChatCompletionRequest } from "./nanogpt-request.js";

export {
  NanoGptSseParser,
  collectSseResponseParts,
  collectSseTextDeltas,
} from "./nanogpt-parser.js";

// ── Module-specific exports (kept in this file) ──────────────────────────────

import { isObject, isPositiveNumber } from "./utils.js";
import {
  type NanoGptModelEntry,
  type NanoGptTokenizer,
  type VscodeLikeMessage,
  type VscodeLikeTool,
  type VscodeModelMetadata,
  resolveRole,
} from "./nanogpt-types.js";
import { getTextPartValue, toNanoGptImagePart } from "./nanogpt-message.js";

function inferTokenizerFromModelIdentity(
  ...values: Array<string | undefined>
): NanoGptTokenizer {
  const normalized = values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  if (
    /(\bgpt-4\b|\bgpt-4-\b|\bgpt-3\.5\b|\bgpt-3\.5-\b|\bgpt-35-turbo\b|\btext-davinci\b|\bcode-davinci\b|\bcode-cushman\b|\bdavinci\b|\bcurie\b|\bbabbage\b|\bada\b)/.test(
      normalized,
    ) &&
    !/\bgpt-4o\b/.test(normalized)
  ) {
    return "cl100k_base";
  }

  return "o200k_base";
}

/**
 * Builds the per-model configuration schema for NanoGPT models.
 *
 * This schema defines connection fields (apiKey, routingMode, provider)
 * and reasoning controls (reasoningEffort, reasoningOutput) that VS Code
 * renders in the per-model configuration panel.
 *
 * NOTE: The `package.json` `languageModelChatProviders` contribution schema
 * is a manual mirror of this function's return value. When properties are
 * added, renamed, or removed here, the corresponding entry in `package.json`
 * must be updated by hand to keep the VS Code extension manifest in sync.
 * A build-step to generate `package.json` from this function would eliminate
 * that sync responsibility if the project grows more schema properties.
 */
export function buildModelConfigurationSchema(): VscodeModelMetadata["configurationSchema"] {
  return {
    type: "object",
    properties: {
      apiKey: {
        type: "string",
        secret: true,
        markdownDescription: "NanoGPT API key.",
      },
      routingMode: {
        type: "string",
        enum: ["subscription", "paygo"],
        enumItemLabels: ["Subscription", "Pay as you go"],
        default: "subscription",
        description: "NanoGPT routing surface for chat completions.",
      },
      provider: {
        type: "string",
        default: "",
        description: "Optional upstream provider id sent as X-Provider when routingMode is paygo.",
      },
      reasoningEffort: {
        type: "string",
        enum: ["auto", "none", "minimal", "low", "medium", "high", "xhigh"],
        enumItemLabels: ["Auto", "None", "Minimal", "Low", "Medium", "High", "Extra High"],
        default: "auto",
        group: "navigation",
        description: "Controls how much reasoning the model applies.",
      },
      reasoningOutput: {
        type: "string",
        enum: ["native", "hidden", "visible"],
        enumItemLabels: ["Native", "Hidden", "Visible fallback"],
        default: "native",
        description: "Controls how streamed reasoning is surfaced by VS Code.",
      },
      toolCallingStrategy: {
        type: "string",
        enum: ["native", "auto", "bridge"],
        enumItemLabels: ["Native", "Auto Retry", "Bridge"],
        default: "native",
        description:
          "Controls tool-calling reliability mode. Native forwards NanoGPT tools directly, auto retries empty or likely scaffolding-only native tool turns with a stricter bridge prompt, and bridge always uses the stricter bridge prompt.",
      },
    },
  };
}

/**
 * Maps an array of raw NanoGPT model entries into VS Code-compatible
 * {@link VscodeModelMetadata} objects.
 *
 * - Filters by optional allowlist when provided.
 * - Normalises variant field names (`context_length` / `contextWindow`,
 *   `max_output_tokens` / `maxTokens`).
 * - Computes `maxInputTokens` as `contextWindow - maxOutputTokens`.
 * - Maps `vision` → `imageInput`, `tool_calling` → `toolCalling`,
 *   and `parallel_tool_calls` → `internal.parallelToolCalls`.
 * - `structured_output` and `pdf_upload` are intentionally excluded
 *   from the VS Code-visible capabilities surface.
 */
export function mapNanoGptModelsToVscode(
  entries: readonly NanoGptModelEntry[],
  allowlist: readonly string[] = [],
): VscodeModelMetadata[] {
  const allowed = new Set(allowlist.map((id) => id.trim()).filter(Boolean));
  const seen = new Set<string>();

  return entries.flatMap((entry) => {
    const id = String(entry.canonicalId ?? entry.id ?? "").trim();
    if (!id || (allowed.size > 0 && !allowed.has(id)) || seen.has(id)) {
      return [];
    }
    seen.add(id);

    const capabilities = entry.capabilities ?? {};
    const reasoning = Boolean(capabilities.reasoning ?? entry.reasoning);
    const family =
      typeof entry.family === "string" && entry.family.trim() ? entry.family.trim() : id;
    const version =
      typeof entry.version === "string" && entry.version.trim() ? entry.version.trim() : id;
    const tokenizer = inferTokenizerFromModelIdentity(id, family, String(entry.name ?? ""));
    const maxOutputTokens = isPositiveNumber(entry.max_output_tokens)
      ? entry.max_output_tokens
      : isPositiveNumber(entry.maxTokens)
        ? entry.maxTokens
        : 32768;
    const contextWindow = isPositiveNumber(entry.context_length)
      ? entry.context_length
      : isPositiveNumber(entry.contextWindow)
        ? entry.contextWindow
        : 200000;

    return [
      {
        id,
        name: String(entry.displayName ?? entry.name ?? id),
        family,
        version,
        maxInputTokens: Math.max(1, contextWindow - maxOutputTokens),
        maxOutputTokens,
        detail: "NanoGPT",
        tooltip: `NanoGPT model ${id}`,
        capabilities: {
          imageInput: Boolean(capabilities.imageInput ?? capabilities.vision ?? entry.vision),
          toolCalling: Boolean(
            capabilities.toolCalling ?? capabilities.tool_calling ?? entry.tool_calling,
          ),
          family,
          tokenizer,
        },
        reasoning,
        internal: {
          parallelToolCalls: Boolean(capabilities.parallel_tool_calls),
        },
        configurationSchema: buildModelConfigurationSchema(),
      },
    ];
  });
}

/**
 * Provides a rough token-count estimate for budget checks.
 *
 * Uses a simple character-count heuristic (`text.length / 4`) plus
 * a flat 1024-token cost per image. This is **not** model-accurate
 * but is sufficient for VS Code's approximate token reporting.
 */
export function estimateTokenCount(
  value: string | VscodeLikeMessage,
  tools?: readonly VscodeLikeTool[],
): number {
  if (typeof value === "string") {
    return Math.max(1, Math.ceil(value.length / 4));
  }

  const imageCount = value.content.filter((part) => toNanoGptImagePart(part) !== null).length;
  let totalText = value.content.map((part) => getTextPartValue(part)).join("");

  // Include nested tool-result payloads in the estimate so VS Code token
  // budgeting reflects large tool outputs.
  for (const part of value.content) {
    if (typeof part.callId !== "string" || !Array.isArray(part.content)) {
      continue;
    }
    for (const contentPart of part.content) {
      if (!isObject(contentPart)) {
        continue;
      }
      const contentText = getTextPartValue(contentPart);
      if (contentText) {
        totalText += contentText;
      }
      if (contentPart.data instanceof Uint8Array) {
        const mimeType =
          typeof contentPart.mimeType === "string" ? contentPart.mimeType : "";
        if (
          mimeType === "application/json" ||
          mimeType.endsWith("+json") ||
          mimeType.startsWith("text/")
        ) {
          totalText += new TextDecoder().decode(contentPart.data);
        }
      }
    }
  }

  let toolTokens = 0;

  if (tools && tools.length > 0) {
    for (const tool of tools) {
      toolTokens += Math.ceil(tool.name.length / 4);
      toolTokens += Math.ceil((tool.description ?? "").length / 4);
      toolTokens += Math.ceil(JSON.stringify(tool.inputSchema ?? {}).length / 4);
    }
  }

  return Math.max(
    1,
    Math.ceil(totalText.length / 4) + imageCount * 1024 + toolTokens,
  );
}
