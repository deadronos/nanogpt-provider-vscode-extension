import * as vscode from "vscode";
import { toNanoGptMessages } from "./nanogpt-message.js";

// ── Prompt TSX extraction ────────────────────────────────────────────────────

/**
 * Reads Prompt TSX parts when the API is available in the current VS Code
 * build. Unsupported or non-string payloads are omitted.
 */
export function getPromptTsxText(part: unknown): string | undefined {
  const promptTsxCtor = (vscode as unknown as {
    LanguageModelPromptTsxPart?: new (...args: never[]) => { value?: unknown };
  }).LanguageModelPromptTsxPart;

  if (!promptTsxCtor || !(part instanceof promptTsxCtor)) {
    return undefined;
  }

  const value = (part as { value?: unknown }).value;
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").join("");
  }

  return undefined;
}

// ── VS Code message-part conversion ──────────────────────────────────────────

/**
 * Converts VS Code's typed chat message parts into the generic
 * `VscodeLikePart` shape expected by {@link toNanoGptMessages}.
 */
export function toCoreMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): Parameters<typeof toNanoGptMessages>[0] {
  return messages.map((message) => ({
    role: message.role,
      name: message.name,
    content: message.content.map((part) => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return { value: part.value };
      }
      if (part instanceof vscode.LanguageModelDataPart) {
        return { data: part.data, mimeType: part.mimeType };
      }
      const promptTsxText = getPromptTsxText(part);
      if (promptTsxText !== undefined) {
        return { value: promptTsxText };
      }
      if (part instanceof vscode.LanguageModelToolCallPart) {
        return { callId: part.callId, name: part.name, input: part.input };
      }
      if (part instanceof vscode.LanguageModelToolResultPart) {
        return {
          callId: part.callId,
          content: part.content.map((contentPart) => {
            if (contentPart instanceof vscode.LanguageModelTextPart) {
              return { value: contentPart.value };
            }
            if (contentPart instanceof vscode.LanguageModelDataPart) {
              return { data: contentPart.data, mimeType: contentPart.mimeType };
            }
            const promptTsxText = getPromptTsxText(contentPart);
            if (promptTsxText !== undefined) {
              return { value: promptTsxText };
            }
            return {};
          }),
        };
      }
      return {};
    }),
  }));
}

/**
 * Maps the VS Code `LanguageModelChatToolMode` enum to the NanoGPT
 * tool-mode string (`"required"`). Returns `undefined`
 * when no mode is configured.
 *
 * `LanguageModelChatToolMode.Auto` is intentionally mapped to
 * `undefined` (no tool-mode header sent) because NanoGPT does not
 * have a direct equivalent — the server defaults to standard
 * tool-calling behavior without it, and the extension's own
 * `toolCallingStrategy` (`auto`/`native`/`bridge`) controls the
 * higher-level tool-calling orchestration.
 */
export function toToolMode(
  toolMode: vscode.LanguageModelChatToolMode | undefined,
): "required" | undefined {
  return toolMode === vscode.LanguageModelChatToolMode.Required ? "required" : undefined;
}

/**
 * Creates a VS Code `LanguageModelThinkingPart` when the API is available
 * in the current VS Code build. Returns `undefined` on older builds that
 * lack thinking part support, allowing fallback to text-based reasoning.
 */
export function createThinkingPart(text: string): vscode.LanguageModelResponsePart | undefined {
  const thinkingCtor = (vscode as unknown as {
    LanguageModelThinkingPart?: new (
      value: string | string[],
      id?: string,
      metadata?: { readonly [key: string]: unknown },
    ) => vscode.LanguageModelResponsePart;
  }).LanguageModelThinkingPart;

  return thinkingCtor ? new thinkingCtor(text) : undefined;
}
