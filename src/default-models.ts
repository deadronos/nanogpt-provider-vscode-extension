import {
  buildModelTooltip,
  buildModelConfigurationSchema,
  type VscodeModelMetadata,
} from "./nanogpt.js";

/**
 * Default model catalogue surfaced to the VS Code model picker when the
 * provider has no API key and no allowlist is configured. These entries
 * are intentionally minimal capability stubs — they advertise the model
 * identity, an approximate context window, and the standard `o200k_base`
 * tokenizer, but they do **not** claim image input, tool calling, or
 * reasoning support because the real capabilities come from the
 * NanoGPT discovery API and cannot be confirmed offline.
 *
 * The catalogue is grouped by model family so the picker shows a
 * representative spread (small fast model, mid-size reasoning model,
 * long-context model) before the first successful discovery round.
 * If NanoGPT later renames or removes any of these ids, the
 * `mapNanoGptModelsToVscode` allowlist filter is the source of truth —
 * the entries below are best-effort placeholders, not guarantees.
 */
export const DEFAULT_MODELS: VscodeModelMetadata[] = [
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    family: "gpt-5.4-mini",
    version: "gpt-5.4-mini",
    maxInputTokens: 200000,
    maxOutputTokens: 32768,
    detail: "NanoGPT (default catalogue)",
    tooltip: buildModelTooltip("gpt-5.4-mini", 200000, 32768),
    capabilities: {
      imageInput: false,
      toolCalling: false,
      family: "gpt-5.4-mini",
      tokenizer: "o200k_base",
    },
    reasoning: false,
    internal: {
      parallelToolCalls: false,
    },
    configurationSchema: buildModelConfigurationSchema(),
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    family: "gpt-5.4",
    version: "gpt-5.4",
    maxInputTokens: 200000,
    maxOutputTokens: 32768,
    detail: "NanoGPT (default catalogue)",
    tooltip: buildModelTooltip("gpt-5.4", 200000, 32768),
    capabilities: {
      imageInput: false,
      toolCalling: false,
      family: "gpt-5.4",
      tokenizer: "o200k_base",
    },
    reasoning: false,
    internal: {
      parallelToolCalls: false,
    },
    configurationSchema: buildModelConfigurationSchema(),
  },
  {
    id: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    family: "claude-sonnet",
    version: "claude-sonnet-4.5",
    maxInputTokens: 200000,
    maxOutputTokens: 16384,
    detail: "NanoGPT (default catalogue)",
    tooltip: buildModelTooltip("claude-sonnet-4.5", 200000, 16384),
    capabilities: {
      imageInput: false,
      toolCalling: false,
      family: "claude-sonnet",
      tokenizer: "o200k_base",
    },
    reasoning: false,
    internal: {
      parallelToolCalls: false,
    },
    configurationSchema: buildModelConfigurationSchema(),
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    family: "gemini-2.5",
    version: "gemini-2.5-pro",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    detail: "NanoGPT (default catalogue)",
    tooltip: buildModelTooltip("gemini-2.5-pro", 1000000, 65536),
    capabilities: {
      imageInput: false,
      toolCalling: false,
      family: "gemini-2.5",
      tokenizer: "o200k_base",
    },
    reasoning: false,
    internal: {
      parallelToolCalls: false,
    },
    configurationSchema: buildModelConfigurationSchema(),
  },
  {
    id: "deepseek-r1",
    name: "DeepSeek R1",
    family: "deepseek-r1",
    version: "deepseek-r1",
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    detail: "NanoGPT (default catalogue)",
    tooltip: buildModelTooltip("deepseek-r1", 128000, 16384),
    capabilities: {
      imageInput: false,
      toolCalling: false,
      family: "deepseek-r1",
      tokenizer: "o200k_base",
    },
    reasoning: false,
    internal: {
      parallelToolCalls: false,
    },
    configurationSchema: buildModelConfigurationSchema(),
  },
];
