// ── NanoGPT API constants ───────────────────────────────────────────────────

export const NANOGPT_BASE_URL = "https://nano-gpt.com/api/v1";
export const NANOGPT_SUBSCRIPTION_BASE_URL = "https://nano-gpt.com/api/subscription/v1";

// ── NanoGPT API types ───────────────────────────────────────────────────────

export type NanoGptRoutingMode = "subscription" | "paygo";

export type NanoGptMessageRole = "system" | "user" | "assistant" | "tool";

export type NanoGptImageUrlContentPart = {
  type: "image_url";
  image_url: {
    url: string;
  };
};

export type NanoGptTextContentPart = {
  type: "text";
  text: string;
};

export type NanoGptMessageContent =
  | string
  | null
  | Array<NanoGptTextContentPart | NanoGptImageUrlContentPart>;

export type NanoGptToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type NanoGptToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
};

export type NanoGptChatMessage = {
  role: NanoGptMessageRole;
  content: NanoGptMessageContent;
  tool_calls?: NanoGptToolCall[];
  tool_call_id?: string;
};

export type VscodeLikePart = {
  kind?: string;
  value?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
  callId?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown;
};

export type VscodeLikeMessage = {
  role: string | number;
  content: readonly VscodeLikePart[];
};

export type NanoGptModelCapabilities = {
  vision?: boolean;
  imageInput?: boolean;
  reasoning?: boolean;
  tool_calling?: boolean;
  toolCalling?: boolean;
  parallel_tool_calls?: boolean;
};

export type NanoGptModelEntry = {
  id?: unknown;
  canonicalId?: unknown;
  name?: unknown;
  displayName?: unknown;
  family?: unknown;
  version?: unknown;
  context_length?: unknown;
  contextWindow?: unknown;
  max_output_tokens?: unknown;
  maxTokens?: unknown;
  capabilities?: NanoGptModelCapabilities;
  reasoning?: unknown;
  vision?: unknown;
  tool_calling?: unknown;
};

export type NanoGptReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type NanoGptReasoningOutput = "hidden" | "native" | "visible";
export type NanoGptToolCallingStrategy = "native" | "auto" | "bridge";
export type NanoGptTokenizer = "cl100k_base" | "o200k_base";

export type VscodeModelMetadata = {
  id: string;
  name: string;
  family: string;
  version: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  tooltip: string;
  detail: string;
  capabilities: {
    imageInput: boolean;
    toolCalling: boolean;
    family?: string;
    tokenizer?: NanoGptTokenizer;
  };
  reasoning: boolean;
  internal?: {
    parallelToolCalls?: boolean;
  };
  configurationSchema?: {
    type: "object";
    properties: Record<string, unknown>;
  };
};

export type VscodeLikeTool = {
  name: string;
  description: string;
  inputSchema?: object;
};

export type NanoGptResponsePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; callId: string; name: string; input: object };

export type NanoGptRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

// ── Role resolution ─────────────────────────────────────────────────────────

/**
 * Resolves a VS Code message role (string or numeric enum) to a
 * NanoGPT-compatible role string. Defaults to `"user"` for unrecognised
 * values.
 */
export function resolveRole(role: string | number): NanoGptMessageRole {
  if (role === "system" || role === 0) {
    return "system";
  }

  if (role === "user" || role === 1) {
    return "user";
  }

  if (role === "assistant" || role === 2) {
    return "assistant";
  }

  return "user";
}
