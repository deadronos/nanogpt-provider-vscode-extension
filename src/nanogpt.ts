export const NANOGPT_BASE_URL = "https://nano-gpt.com/api/v1";
export const NANOGPT_SUBSCRIPTION_BASE_URL = "https://nano-gpt.com/api/subscription/v1";

export type NanoGptRoutingMode = "subscription" | "paygo";

export type NanoGptMessageRole = "system" | "user" | "assistant";

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
  | Array<NanoGptTextContentPart | NanoGptImageUrlContentPart>;

export type NanoGptChatMessage = {
  role: NanoGptMessageRole;
  content: NanoGptMessageContent;
};

export type VscodeLikePart = {
  kind?: string;
  value?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
};

export type VscodeLikeMessage = {
  role: string | number;
  content: readonly VscodeLikePart[];
};

export type NanoGptModelCapabilities = {
  vision?: boolean;
  imageInput?: boolean;
  tool_calling?: boolean;
  toolCalling?: boolean;
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
  vision?: unknown;
  tool_calling?: unknown;
};

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
};

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

export function toNanoGptMessages(messages: readonly VscodeLikeMessage[]): NanoGptChatMessage[] {
  return messages
    .map((message) => {
      const contentParts: Array<NanoGptTextContentPart | NanoGptImageUrlContentPart> = [];

      for (const part of message.content) {
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

      const hasImage = contentParts.some((part) => part.type === "image_url");
      const content = hasImage
        ? contentParts
        : contentParts
            .filter((part): part is NanoGptTextContentPart => part.type === "text")
            .map((part) => part.text)
            .join("");

      return {
        role: resolveRole(message.role),
        content,
      };
    })
    .filter((message) =>
      typeof message.content === "string" ? message.content.trim().length > 0 : message.content.length > 0,
    );
}

export function buildNanoGptChatCompletionRequest(params: {
  apiKey: string;
  modelId: string;
  messages: readonly NanoGptChatMessage[];
  routingMode: NanoGptRoutingMode;
  provider?: string;
  maxTokens?: number;
}): NanoGptRequest {
  const baseUrl =
    params.routingMode === "subscription" ? NANOGPT_SUBSCRIPTION_BASE_URL : NANOGPT_BASE_URL;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.apiKey}`,
    "Content-Type": "application/json",
  };

  if (params.routingMode === "paygo" && params.provider?.trim()) {
    headers["X-Provider"] = params.provider.trim();
  }

  return {
    url: `${baseUrl}/chat/completions`,
    headers,
    body: JSON.stringify({
      model: params.modelId,
      messages: params.messages,
      stream: true,
      ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
    }),
  };
}

export function collectSseTextDeltas(lines: readonly string[]): string[] {
  const deltas: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }

    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }

    try {
      const parsed = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: unknown } }>;
      };
      const content = parsed.choices?.[0]?.delta?.content;
      if (typeof content === "string" && content.length > 0) {
        deltas.push(content);
      }
    } catch {
      continue;
    }
  }

  return deltas;
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
