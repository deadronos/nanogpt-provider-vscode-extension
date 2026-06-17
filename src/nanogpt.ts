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

export { buildNanoGptChatCompletionRequest, prepareChatRequest, truncateMessagesForContext } from "./nanogpt-request.js";

export {
  NanoGptSseParser,
  collectSseResponseParts,
  collectSseTextDeltas,
} from "./nanogpt-parser.js";

// ── Module-specific exports (kept in this file) ──────────────────────────────

import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base_ranks from "js-tiktoken/ranks/cl100k_base";
import o200k_base_ranks from "js-tiktoken/ranks/o200k_base";
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

// ── Lazy encoder cache ──────────────────────────────────────────────────────
//
// `Tiktoken` instances are expensive to construct (they load large BPE rank
// tables), so we create them once per tokenizer family and reuse them for
// the lifetime of the extension host.
const encoderCache = new Map<NanoGptTokenizer, Tiktoken>();

function getEncoder(tokenizer: NanoGptTokenizer): Tiktoken | null {
  const cached = encoderCache.get(tokenizer);
  if (cached) return cached;
  if (tokenizer !== "cl100k_base" && tokenizer !== "o200k_base") {
    return null;
  }
  try {
    const rankData = tokenizer === "cl100k_base" ? cl100k_base_ranks : o200k_base_ranks;
    const enc = new Tiktoken(rankData);
    encoderCache.set(tokenizer, enc);
    return enc;
  } catch {
    return null;
  }
}

/**
 * Patterns identifying OpenAI families that use the `cl100k_base` BPE
 * vocabulary (legacy GPT-3.5 / GPT-4, base GPT-3, embeddings, and
 * Codex-style models). The patterns are matched as standalone tokens
 * (`\b` boundaries) to avoid spurious hits like `gpt-4o-mini`.
 */
const CL100K_BASE_MODEL_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgpt-3\.5\b/,
  /\bgpt-3\.5-\b/,
  /\bgpt-4\b/,
  /\bgpt-4-\b/,
  /\bgpt-35-turbo\b/,
  /\btext-davinci\b/,
  /\btext-curie\b/,
  /\btext-babbage\b/,
  /\btext-ada\b/,
  /\btext-embedding-ada\b/,
  /\bcode-davinci\b/,
  /\bcode-cushman\b/,
  /\bcode-search\b/,
  /\bdavinci\b/,
  /\bcurie\b/,
  /\bbabbage\b/,
  /\bada\b/,
];

/**
 * Patterns identifying modern OpenAI families that use `o200k_base`,
 * which the legacy detector above would otherwise misclassify as
 * `cl100k_base` (e.g. `gpt-4.1`, `gpt-5`, the `o-series`).
 */
const O200K_BASE_OVERRIDE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgpt-4o\b/,
  /\bgpt-4\.1\b/,
  /\bgpt-4\.5\b/,
  /\bgpt-5\b/,
  /\bgpt-oss\b/,
  /\bo[1-9](?:-(?:mini|pro))?\b/,
];

/**
 * Heuristically infers a NanoGPT tokenizer family from model-identity
 * fields (id, family, name). Returns `cl100k_base` for legacy OpenAI
 * families and `o200k_base` for modern OpenAI families and unknown
 * third-party models.
 *
 * NOTE: This is a best-effort heuristic. The NanoGPT discovery API does
 * not currently surface a tokenizer field, so the result is informational
 * and may be inaccurate for non-OpenAI models (e.g. Llama, Mistral,
 * Claude). The actual token count in `estimateTokenCount` uses a
 * character-count heuristic and does not depend on this value.
 */
function inferTokenizerFromModelIdentity(
  ...values: Array<string | undefined>
): NanoGptTokenizer {
  const normalized = values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  if (O200K_BASE_OVERRIDE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "o200k_base";
  }

  if (CL100K_BASE_MODEL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "cl100k_base";
  }

  return "o200k_base";
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function buildModelTooltip(
  id: string,
  maxInputTokens: number,
  maxOutputTokens: number,
): string {
  return `NanoGPT model ${id} — ${formatTokenCount(maxInputTokens)} input / ${formatTokenCount(maxOutputTokens)} output tokens`;
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
        default: "auto",
        group: "navigation",
        description: "Controls how much reasoning the model applies.",
      },
      reasoningOutput: {
        type: "string",
        enum: ["native", "hidden", "visible"],
        default: "native",
        description: "Controls how streamed reasoning is surfaced by VS Code.",
      },
      toolCallingStrategy: {
        type: "string",
        enum: ["native", "auto", "bridge"],
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
 * - Treats `context_length` / `contextWindow` as `maxInputTokens` directly.
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
        maxInputTokens: contextWindow,
        maxOutputTokens,
        detail: "NanoGPT",
        tooltip: buildModelTooltip(id, contextWindow, maxOutputTokens),
        capabilities: {
          imageInput: Boolean(capabilities.imageInput ?? capabilities.vision ?? entry.vision),
            toolCalling: capabilities.parallel_tool_calls
              ? 8
              : Boolean(
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
 * Provides a token-count estimate for budget checks.
 *
 * When `tokenizer` is provided (from `model.capabilities.tokenizer`), uses
 * the `js-tiktoken` BPE encoder for accurate token counts matching the
 * model's native vocabulary. Falls back to a character-count heuristic
 * (`text.length / 4`) when no tokenizer is available (e.g. offline default
 * models or encoding errors). Images are always counted as a flat 1024
 * tokens because VS Code does not decode image payloads here.
 */
export function estimateTokenCount(
  value: string | VscodeLikeMessage,
  tools?: readonly VscodeLikeTool[],
  tokenizer?: NanoGptTokenizer,
): number {
  const encoder = tokenizer ? getEncoder(tokenizer) : null;

  const countText = (text: string): number =>
    encoder ? encoder.encode(text).length : Math.ceil(text.length / 4);

  if (typeof value === "string") {
    return Math.max(1, countText(value));
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
      toolTokens += countText(tool.name);
      toolTokens += countText(tool.description ?? "");
      toolTokens += countText(JSON.stringify(tool.inputSchema ?? {}));
    }
  }

  return Math.max(
    1,
    countText(totalText) + imageCount * 1024 + toolTokens,
  );
}
