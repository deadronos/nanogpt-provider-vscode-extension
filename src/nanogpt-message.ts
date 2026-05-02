import { isObject, toBase64 } from "./utils.js";
import {
  type NanoGptChatMessage,
  type NanoGptImageUrlContentPart,
  type NanoGptTextContentPart,
  type NanoGptToolCall,
  type VscodeLikePart,
  type VscodeLikeMessage,
  type VscodeLikeTool,
  resolveRole,
} from "./nanogpt-types.js";

// ── Part value extraction ───────────────────────────────────────────────────

/**
 * Extracts the text content from a VS Code-like message part.
 *
 * Checks both `part.value` and `part.text` as VS Code uses different
 * property names depending on whether the part comes from the real API
 * or a test helper.
 */
export function getTextPartValue(part: VscodeLikePart): string {
  if (typeof part.value === "string") {
    return part.value;
  }

  if (typeof part.text === "string") {
    return part.text;
  }

  return "";
}

// ── Part conversion helpers ─────────────────────────────────────────────────

/**
 * Converts a VS Code data part to a NanoGPT `image_url` content part
 * when it carries image bytes. Returns `null` when the part is not
 * an image or lacks `Uint8Array` data.
 */
export function toNanoGptImagePart(part: VscodeLikePart): NanoGptImageUrlContentPart | null {
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

/**
 * Converts a VS Code tool-call part into a NanoGPT `NanoGptToolCall`.
 * Returns `null` when the part lacks a `callId` or `name`.
 */
export function toToolCall(part: VscodeLikePart): NanoGptToolCall | null {
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

/**
 * Converts a VS Code tool-result part into a plain-text content string.
 *
 * Handles text sub-parts, JSON/UTF-8 data sub-parts, and generic
 * binary sub-parts (encoded as `data:` URIs). Returns `null` when
 * the part is not a tool result.
 */
export function toToolResultContent(part: VscodeLikePart): string | null {
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

// ── Message conversion ──────────────────────────────────────────────────────

/**
 * Converts an array of VS Code-like chat messages into the
 * OpenAI-compatible NanoGPT message format.
 *
 * - Text parts become `content: string`.
 * - Image data parts become `image_url` content blocks.
 * - Tool-call parts become `tool_calls[]` on assistant messages.
 * - Tool-result parts become `role: "tool"` messages.
 * - Empty messages are filtered out.
 * - When a user message contains both text and tool results, the
 *   text is preserved as a separate message before the tool results.
 */
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

// ── Tool serialization ──────────────────────────────────────────────────────

/**
 * Converts VS Code-like tool definitions into the NanoGPT
 * OpenAI-compatible `tools` array.
 *
 * Validates that the serialized payload does not exceed the
 * 200 KB NanoGPT limit. Returns `undefined` when tools are
 * absent or empty.
 *
 * @throws If the serialized tools exceed the 200 KB limit.
 */
export function toNanoGptTools(tools: readonly VscodeLikeTool[] | undefined): unknown[] | undefined {
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
