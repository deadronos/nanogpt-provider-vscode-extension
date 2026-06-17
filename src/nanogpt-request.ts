import {
  NANOGPT_BASE_URL,
  NANOGPT_SUBSCRIPTION_BASE_URL,
  type NanoGptChatMessage,
  type NanoGptReasoningEffort,
  type NanoGptReasoningOutput,
  type NanoGptRequest,
  type NanoGptRoutingMode,
  type VscodeLikeTool,
} from "./nanogpt-types.js";
import { toNanoGptTools } from "./nanogpt-message.js";

/**
 * Maximum size (in bytes) for a base64-encoded inline image payload
 * before `prepareChatRequest` strips it to avoid blowing up the
 * NanoGPT request body or triggering upstream timeouts. The limit is
 * deliberately generous — most inline images in Copilot Chat are small
 * screenshots or thumbnails — and can be raised in the future.
 */
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MiB

/** Minimal logger contract so callers can thread their own logger through. */
export type PrepareChatRequestLogger = {
  warn(message: string): void;
};

/**
 * Internal request-preparation hook that normalises the message array
 * before it is serialised for NanoGPT. This is the extension-local
 * equivalent of the `prepareLanguageModelChat` hook that newer VS Code
 * APIs may surface on `LanguageModelChatInformation` in the future.
 *
 * Current normalisations:
 * 1. Strips base64-encoded inline image parts that exceed
 *    {@link MAX_INLINE_IMAGE_BYTES} so the request body does not
 *    balloon past NanoGPT's upload limits.
 * 2. Drops empty assistant turns that some VS Code versions inject
 *    before tool-call sequences.
 *
 * When VS Code lands a formal `prepareLanguageModelChat` hook, this
 * function should be wired into it so the same normalisations apply
 * regardless of whether the hook is called by VS Code or by the
 * extension itself.
 */
export function prepareChatRequest(
  messages: readonly NanoGptChatMessage[],
  logger?: PrepareChatRequestLogger,
): NanoGptChatMessage[] {
  const result: NanoGptChatMessage[] = [];

  for (const message of messages) {
    // Drop empty assistant turns — some VS Code versions insert these
    // before tool-call sequences and they confuse upstream models.
    if (message.role === "assistant" && !message.content) {
      continue;
    }

    if (!Array.isArray(message.content)) {
      result.push(message);
      continue;
    }

    let droppedImageCount = 0;
    let droppedImageBytes = 0;

    const filteredParts = message.content.filter((part) => {
      if (typeof part === "object" && part !== null && part.type === "image_url") {
        const url = (part as { image_url?: { url?: string } }).image_url?.url;
        if (typeof url === "string" && url.startsWith("data:")) {
          // Estimate the decoded byte-length from the base64 payload.
          const base64Start = url.indexOf(",");
          if (base64Start !== -1) {
            const base64Payload = url.slice(base64Start + 1);
            const byteLength = Math.floor((base64Payload.length * 3) / 4);
            if (byteLength > MAX_INLINE_IMAGE_BYTES) {
              droppedImageCount += 1;
              droppedImageBytes += byteLength;
              return false;
            }
          }
        }
      }
      return true;
    });

    if (droppedImageCount > 0 && logger) {
      logger.warn(
        `NanoGPT prepareChatRequest dropped ${droppedImageCount} oversized inline image(s) (total approx bytes=${droppedImageBytes}, role=${message.role})`,
      );
    }

    result.push(filteredParts.length === message.content.length
      ? message
      : { ...message, content: filteredParts });
  }

  return result;
}


function estimateMessageTokens(message: NanoGptChatMessage): number {
  if (typeof message.content === "string") return Math.max(1, Math.ceil(message.content.length / 4));
  if (!Array.isArray(message.content)) return 1;
  let chars = 0;
  for (const part of message.content) {
    if (part.type === "text" && typeof part.text === "string") chars += part.text.length;
    else if (part.type === "image_url") chars += 1024 * 4;
    chars += 4;
  }
  return Math.max(1, Math.ceil(chars / 4));
}


export function truncateMessagesForContext(messages: readonly NanoGptChatMessage[], maxInputTokens: number, logger?: PrepareChatRequestLogger): NanoGptChatMessage[] {
  if (messages.length === 0) return [];
  let totalTokens = 0;
  for (const msg of messages) totalTokens += estimateMessageTokens(msg);
  const budget = Math.floor(maxInputTokens * 0.9);
  if (totalTokens <= budget) return [...messages];
  const result = [...messages];
  const dropped = [];
  while (totalTokens > budget && result.length > 0) {
    let dropIndex = -1;
    for (let i = 0; i < result.length; i++) {
      if (result[i].role !== "system") { dropIndex = i; break; }
    }
    if (dropIndex === -1) break;
    const removed = result.splice(dropIndex, 1)[0];
    dropped.push(removed);
    totalTokens -= estimateMessageTokens(removed);
  }
  if (dropped.length > 0 && logger) {
    const dt = dropped.reduce((s, m) => s + estimateMessageTokens(m), 0);
    logger.warn("NanoGPT truncateMessagesForContext: estimated " + (totalTokens + dt) + " tokens exceeds budget " + budget + " (maxInputTokens=" + maxInputTokens + "). Dropped " + dropped.length + " oldest non-system messages to fit within budget. Remaining: " + result.length + " messages, ~" + totalTokens + " estimated tokens.");
  }
  return result;
}


/**
 * Builds the full HTTP request configuration for a NanoGPT
 * chat completion call.
 *
 * Selects the appropriate base URL from the routing mode,
 * adds the `X-Provider` header in paygo mode when a provider
 * is specified, and assembles the JSON body with stream, tool,
 * reasoning, and token controls.
 *
 * @returns A {@link NanoGptRequest} with `url`, `headers`, and `body`.
 */
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
      ...(params.reasoningEffort
        ? { reasoning_effort: params.reasoningEffort }
        : {}),
      ...(params.reasoningOutput === "hidden"
        ? {}
        : { reasoning: { exclude: false } }),
    }),
  };
}
