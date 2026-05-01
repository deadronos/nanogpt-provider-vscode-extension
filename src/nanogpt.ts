export const NANOGPT_BASE_URL = "https://nano-gpt.com/api/v1";
export const NANOGPT_SUBSCRIPTION_BASE_URL = "https://nano-gpt.com/api/subscription/v1";

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
  context_length?: unknown;
  contextWindow?: unknown;
  max_output_tokens?: unknown;
  maxTokens?: unknown;
  capabilities?: NanoGptModelCapabilities;
  reasoning?: unknown;
  vision?: unknown;
  tool_calling?: unknown;
};

export type NanoGptReasoningEffort = "none" | "minimal" | "auto" | "low" | "medium" | "high" | "xhigh";
export type NanoGptReasoningOutput = "hidden" | "native" | "visible";

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

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveRole(role: string | number): NanoGptMessageRole {
  if (role === "system" || role === "user" || role === "assistant") {
    return role;
  }

  if (role === 1) {
    return "user";
  }

  if (role === 2) {
    return "assistant";
  }

  return "user";
}

function getTextPartValue(part: VscodeLikePart): string {
  if (typeof part.value === "string") {
    return part.value;
  }

  if (typeof part.text === "string") {
    return part.text;
  }

  return "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

function toNanoGptImagePart(part: VscodeLikePart): NanoGptImageUrlContentPart | null {
  if (!(part.data instanceof Uint8Array)) {
    return null;
  }

  const mimeType = typeof part.mimeType === "string" ? part.mimeType : "application/octet-stream";
  if (!mimeType.startsWith("image/")) {
    return null;
  }

  return {
    type: "image_url",
    image_url: {
      url: `data:${mimeType};base64,${toBase64(part.data)}`,
    },
  };
}

function toToolCall(part: VscodeLikePart): NanoGptToolCall | null {
  if (typeof part.callId !== "string" || typeof part.name !== "string") {
    return null;
  }

  return {
    id: part.callId,
    type: "function",
    function: {
      name: part.name,
      arguments: JSON.stringify(isObject(part.input) ? part.input : {}),
    },
  };
}

function toToolResultContent(part: VscodeLikePart): string | null {
  if (typeof part.callId !== "string" || !Array.isArray(part.content)) {
    return null;
  }

  const values = part.content.map((contentPart) => {
    if (!isObject(contentPart)) {
      return "";
    }

    const text = getTextPartValue(contentPart);
    if (text) {
      return text;
    }

    if (contentPart.data instanceof Uint8Array) {
      const mimeType =
        typeof contentPart.mimeType === "string" ? contentPart.mimeType : "application/octet-stream";
      if (mimeType === "application/json" || mimeType.endsWith("+json")) {
        return Buffer.from(contentPart.data).toString("utf8");
      }
      if (mimeType.startsWith("text/")) {
        return Buffer.from(contentPart.data).toString("utf8");
      }
      return `data:${mimeType};base64,${toBase64(contentPart.data)}`;
    }

    return "";
  });

  return values.filter(Boolean).join("\n");
}

export function toNanoGptMessages(messages: readonly VscodeLikeMessage[]): NanoGptChatMessage[] {
  return messages
    .flatMap((message) => {
      const toolResultMessages: NanoGptChatMessage[] = [];
      const toolCalls: NanoGptToolCall[] = [];
      const contentParts: Array<NanoGptTextContentPart | NanoGptImageUrlContentPart> = [];

      for (const part of message.content) {
        const toolResultContent = toToolResultContent(part);
        if (toolResultContent !== null && typeof part.callId === "string") {
          toolResultMessages.push({
            role: "tool",
            tool_call_id: part.callId,
            content: toolResultContent,
          });
          continue;
        }

        const toolCall = toToolCall(part);
        if (toolCall) {
          toolCalls.push(toolCall);
          continue;
        }

        const text = getTextPartValue(part);
        if (text) {
          contentParts.push({ type: "text", text });
          continue;
        }

        const imagePart = toNanoGptImagePart(part);
        if (imagePart) {
          contentParts.push(imagePart);
        }
      }

      if (toolResultMessages.length > 0) {
        // Preserve text content alongside tool results when both are present.
        const hasText = contentParts.some(
          (part) => part.type === "text" && (part as NanoGptTextContentPart).text.trim(),
        );
        if (hasText) {
          const textContent = contentParts
            .filter((part): part is NanoGptTextContentPart => part.type === "text")
            .map((part) => part.text)
            .join("");
          return [
            {
              role: resolveRole(message.role),
              content: textContent,
            } as NanoGptChatMessage,
            ...toolResultMessages,
          ];
        }
        return toolResultMessages;
      }

      const hasImage = contentParts.some((part) => part.type === "image_url");
      const content = hasImage
        ? contentParts
        : contentParts
            .filter((part): part is NanoGptTextContentPart => part.type === "text")
            .map((part) => part.text)
            .join("");

      const nanoMessage: NanoGptChatMessage = {
        role: resolveRole(message.role),
        content,
      };

      if (toolCalls.length > 0) {
        nanoMessage.tool_calls = toolCalls;
      }

      return [nanoMessage];
    })
    .filter((message) => {
      if (message.tool_calls && message.tool_calls.length > 0) {
        return true;
      }
      if (message.role === "tool") {
        return typeof message.content === "string";
      }
      if (typeof message.content === "string") {
        return message.content.trim().length > 0;
      }
      return Array.isArray(message.content) && message.content.length > 0;
    });
}

function toNanoGptTools(tools: readonly VscodeLikeTool[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const serialized = JSON.stringify(tools);
  if (new TextEncoder().encode(serialized).length > 200 * 1024) {
    throw new Error(
      "NanoGPT tool payload exceeds the 200 KB limit. " +
        "Try reducing the number of tools or simplifying tool descriptions and input schemas.",
    );
  }

  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? {
        type: "object",
        properties: {},
      },
    },
  }));
}

export function buildNanoGptChatCompletionRequest(params: {
  apiKey: string;
  modelId: string;
  messages: readonly NanoGptChatMessage[];
  routingMode: NanoGptRoutingMode;
  provider?: string;
  maxTokens?: number;
  tools?: readonly VscodeLikeTool[];
  toolMode?: "auto" | "required";
  reasoningEffort?: NanoGptReasoningEffort;
  reasoningOutput?: NanoGptReasoningOutput;
  parallelToolCalls?: boolean;
}): NanoGptRequest {
  const baseUrl =
    params.routingMode === "subscription" ? NANOGPT_SUBSCRIPTION_BASE_URL : NANOGPT_BASE_URL;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.apiKey}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };

  if (params.routingMode === "paygo" && params.provider?.trim()) {
    headers["X-Provider"] = params.provider.trim();
  }

  const tools = toNanoGptTools(params.tools);

  return {
    url: `${baseUrl}/chat/completions`,
    headers,
    body: JSON.stringify({
      model: params.modelId,
      messages: params.messages,
      stream: true,
      ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
      ...(tools ? { tools } : {}),
      ...(tools && params.toolMode === "required" ? { tool_choice: "required" } : {}),
      ...(params.parallelToolCalls ? { parallel_tool_calls: true } : {}),
      ...(params.reasoningEffort && params.reasoningEffort !== "auto"
        ? { reasoning_effort: params.reasoningEffort }
        : {}),
      ...(params.reasoningOutput
        ? { reasoning: { exclude: params.reasoningOutput === "hidden" } }
        : {}),
    }),
  };
}

type ParsedSseChunk = {
  choices?: Array<{
    delta?: {
      content?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
      thinking?: unknown;
      tool_calls?: Array<{
        index?: unknown;
        id?: unknown;
        type?: unknown;
        function?: {
          name?: unknown;
          arguments?: unknown;
        };
      }>;
    };
    finish_reason?: unknown;
  }>;
};

type PendingToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export class NanoGptSseParser {
  private readonly toolCalls = new Map<number, PendingToolCall>();
  private emittedToolCalls = false;
  private lastSeenIndex = 0;

  acceptLines(lines: readonly string[]): NanoGptResponsePart[] {
    const parts: NanoGptResponsePart[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }

      const payload = trimmed.slice("data:".length).trim();
      if (!payload) {
        continue;
      }

      if (payload === "[DONE]") {
        parts.push(...this.flushToolCalls());
        continue;
      }

      try {
        const parsed = JSON.parse(payload) as ParsedSseChunk;
        for (const choice of parsed.choices ?? []) {
          const content = choice.delta?.content;
          if (typeof content === "string" && content.length > 0) {
            parts.push({ type: "text", text: content });
          }

          for (const reasoning of [
            choice.delta?.reasoning,
            choice.delta?.reasoning_content,
            choice.delta?.thinking,
          ]) {
            if (typeof reasoning === "string" && reasoning.length > 0) {
              parts.push({ type: "reasoning", text: reasoning });
            }
          }

          for (const toolCall of choice.delta?.tool_calls ?? []) {
            const index = isPositiveNumber(toolCall.index) ? toolCall.index : this.lastSeenIndex;
            if (isPositiveNumber(toolCall.index)) {
              this.lastSeenIndex = toolCall.index;
            }

            const pending = this.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
            if (typeof toolCall.id === "string") {
              pending.id = toolCall.id;
            }
            if (typeof toolCall.function?.name === "string") {
              pending.name += toolCall.function.name;
            }
            if (typeof toolCall.function?.arguments === "string") {
              pending.arguments += toolCall.function.arguments;
            }
            this.toolCalls.set(index, pending);
          }

          if (choice.finish_reason === "tool_calls") {
            parts.push(...this.flushToolCalls());
          }
        }
      } catch {
        continue;
      }
    }

    return parts;
  }

  private flushToolCalls(): NanoGptResponsePart[] {
    if (this.emittedToolCalls || this.toolCalls.size === 0) {
      return [];
    }

    this.emittedToolCalls = true;
    return [...this.toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([, toolCall]) => {
        if (!toolCall.id || !toolCall.name) {
          return [];
        }

        try {
          const input = JSON.parse(toolCall.arguments || "{}") as unknown;
          return [
            {
              type: "tool_call" as const,
              callId: toolCall.id,
              name: toolCall.name,
              input: isObject(input) ? input : {},
            },
          ];
        } catch {
          return [
            {
              type: "tool_call" as const,
              callId: toolCall.id,
              name: toolCall.name,
              input: {},
            },
          ];
        }
      });
  }
}

export function collectSseResponseParts(lines: readonly string[]): NanoGptResponsePart[] {
  return new NanoGptSseParser().acceptLines(lines);
}

export function collectSseTextDeltas(lines: readonly string[]): string[] {
  return collectSseResponseParts(lines).flatMap((part) => (part.type === "text" ? [part.text] : []));
}

export function buildReasoningConfigurationSchema(): VscodeModelMetadata["configurationSchema"] {
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
    },
  };
}

export function mapNanoGptModelsToVscode(
  entries: readonly NanoGptModelEntry[],
  allowlist: readonly string[] = [],
): VscodeModelMetadata[] {
  const allowed = new Set(allowlist.map((id) => id.trim()).filter(Boolean));

  return entries.flatMap((entry) => {
    const id = String(entry.canonicalId ?? entry.id ?? "").trim();
    if (!id || (allowed.size > 0 && !allowed.has(id))) {
      return [];
    }

    const capabilities = entry.capabilities ?? {};
    const reasoning = Boolean(capabilities.reasoning ?? entry.reasoning);
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
        family: "nanogpt",
        version: "nano-gpt",
        maxInputTokens: Math.max(1, contextWindow - maxOutputTokens),
        maxOutputTokens,
        detail: "NanoGPT",
        tooltip: `NanoGPT model ${id}`,
        capabilities: {
          imageInput: Boolean(capabilities.imageInput ?? capabilities.vision ?? entry.vision),
          toolCalling: Boolean(
            capabilities.toolCalling ?? capabilities.tool_calling ?? entry.tool_calling,
          ),
        },
        reasoning,
        internal: {
          parallelToolCalls: Boolean(capabilities.parallel_tool_calls),
        },
        configurationSchema: buildReasoningConfigurationSchema(),
      },
    ];
  });
}

export function estimateTokenCount(value: string | VscodeLikeMessage): number {
  const text =
    typeof value === "string"
      ? value
      : value.content.map((part) => getTextPartValue(part)).join("");
  const imageCount =
    typeof value === "string"
      ? 0
      : value.content.filter((part) => toNanoGptImagePart(part) !== null).length;
  return Math.max(1, Math.ceil(text.length / 4) + imageCount * 1024);
}
