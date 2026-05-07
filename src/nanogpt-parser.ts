import { isObject } from "./utils.js";
import type { NanoGptResponsePart } from "./nanogpt-types.js";

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

/**
 * Incrementally parses OpenAI-compatible SSE (Server-Sent Events) chunks
 * from a streaming chat completion response.
 *
 * Accumulates partial tool-call deltas across chunks and flushes
 * completed tool calls when `finish_reason === "tool_calls"` or
 * when a `[DONE]` token is received.
 *
 * Reasoning deltas are extracted from `reasoning`, `reasoning_content`,
 * and `thinking` fields — all three are common across different upstream
 * providers.
 *
 * Usage: create one instance per stream, then call {@link acceptLines}
 * with each batch of buffered SSE lines.
 */
export class NanoGptSseParser {
  private readonly toolCalls = new Map<number, PendingToolCall>();
  private emittedToolCalls = false;
  private lastSeenIndex = 0;

  /**
   * Feeds one or more SSE lines into the parser and returns any
   * completed response parts (text, reasoning, or tool calls).
   *
   * @param lines - Raw SSE lines, typically split from a streamed buffer.
   * @returns Zero or more parsed {@link NanoGptResponsePart} items.
   */
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

          // Take the first non-empty reasoning field per chunk. Providers vary
          // in which field they use; consuming only the first prevents duplicate
          // output when a single delta populates more than one of these fields.
          const reasoningText = [
            choice.delta?.reasoning,
            choice.delta?.reasoning_content,
            choice.delta?.thinking,
          ].find((r): r is string => typeof r === "string" && r.length > 0);
          if (reasoningText !== undefined) {
            parts.push({ type: "reasoning", text: reasoningText });
          }

          for (const toolCall of choice.delta?.tool_calls ?? []) {
            // Tool-call indexes are zero-based, so accept 0 as an explicit index.
            const rawIndex = toolCall.index;
            const hasIndex =
              typeof rawIndex === "number" && Number.isFinite(rawIndex) && rawIndex >= 0;
            const index = hasIndex ? rawIndex : this.lastSeenIndex;
            if (hasIndex) {
              this.lastSeenIndex = rawIndex;
            }

            const pending = this.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
            if (typeof toolCall.id === "string") {
              pending.id = toolCall.id;
            }
            if (typeof toolCall.function?.name === "string") {
              pending.name = toolCall.function.name;
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

  /**
   * Flushes all accumulated tool calls, sorted by index, and
   * parses their serialised arguments. Skips calls with missing
   * `id` or `name` and falls back to `{}` when JSON parsing fails.
   *
   * Tool calls are only emitted once per stream — repeated flushes
   * after the first are no-ops.
   */
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

/**
 * Convenience: runs a fresh {@link NanoGptSseParser} over an array of
 * SSE lines and returns the complete list of response parts.
 */
export function collectSseResponseParts(lines: readonly string[]): NanoGptResponsePart[] {
  return new NanoGptSseParser().acceptLines(lines);
}

/**
 * Convenience: extracts only the text deltas from an array of SSE lines.
 */
export function collectSseTextDeltas(lines: readonly string[]): string[] {
  return collectSseResponseParts(lines).flatMap((part) => (part.type === "text" ? [part.text] : []));
}
