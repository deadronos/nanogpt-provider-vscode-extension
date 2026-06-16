import { NanoGptSseParser } from "./nanogpt-parser.js";
import type { NanoGptResponsePart, NanoGptRequest } from "./nanogpt-types.js";
import { getHeader } from "./utils.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type StreamProcessingSummary = {
  chunkCount: number;
  textPartCount: number;
  reasoningPartCount: number;
  toolCallCount: number;
};

/** Minimal logger contract for stream-level logging. */
type StreamLogger = {
  debug(message: string): void;
  warn(message: string): void;
  trace(message: string): void;
};

// ── Streaming HTTP execution ────────────────────────────────────────────────

/**
 * Posts a chat completion request and processes the SSE response stream,
 * dispatching each parsed part to `onPart` and returning aggregate part counts.
 *
 * This is the core HTTP+SSE pipeline shared by native and bridge streaming.
 */
export async function executeStreamingRequest(
  fetchImpl: typeof fetch,
  logger: StreamLogger,
  params: {
    request: NanoGptRequest;
    requestId: string;
    signal?: AbortSignal;
    onPart: (part: NanoGptResponsePart) => void;
  },
): Promise<StreamProcessingSummary> {
  const response = await fetchImpl(params.request.url, {
    method: "POST",
    headers: params.request.headers,
    body: params.request.body,
    signal: params.signal,
  });

  logger.debug(
    `[${params.requestId}] chat response received (status=${response.status}, contentType=${getHeader(response, "content-type")})`,
  );

  if (!response.ok) {
    let message = "NanoGPT chat request failed with HTTP " + response.status;
    try {
      const body = await response.json() as { error?: { message?: string; code?: string; type?: string } };
      if (body?.error?.message) {
        message = "[NanoGPT] " + body.error.message + (body.error.type ? " (" + body.error.type + ")" : "") + (body.error.code ? " [" + body.error.code + "]" : "");
      }
    } catch {
      // Use the default message if the body is not JSON.
    }
    throw new Error(message);
  }

  if (!response.body) {
    logger.warn(`[${params.requestId}] chat response had no body`);
    return {
      chunkCount: 0,
      textPartCount: 0,
      reasoningPartCount: 0,
      toolCallCount: 0,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new NanoGptSseParser();
  let buffer = "";
  const summary: StreamProcessingSummary = {
    chunkCount: 0,
    textPartCount: 0,
    reasoningPartCount: 0,
    toolCallCount: 0,
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      summary.chunkCount += 1;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      processStreamParts(parser.acceptLines(lines), params.onPart, summary);
    }

    buffer += decoder.decode();
    processStreamParts(parser.acceptLines(buffer.split(/\r?\n/)), params.onPart, summary);
    processStreamParts(parser.flushPendingToolCalls(), params.onPart, summary);
    logger.trace(
      `[${params.requestId}] chat stream processed (chunks=${summary.chunkCount}, textParts=${summary.textPartCount}, reasoningParts=${summary.reasoningPartCount}, toolCalls=${summary.toolCallCount})`,
    );
    return summary;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore reader teardown failures; the stream is already ending.
    }
    reader.releaseLock();
  }
}

// ── Part dispatch helpers ───────────────────────────────────────────────────

function processStreamParts(
  parts: readonly NanoGptResponsePart[],
  onPart: (part: NanoGptResponsePart) => void,
  summary: StreamProcessingSummary,
): void {
  emitParts(parts, {
    onText: (text) => {
      summary.textPartCount += 1;
      onPart({ type: "text", text });
    },
    onReasoning: (text) => {
      summary.reasoningPartCount += 1;
      onPart({ type: "reasoning", text });
    },
    onToolCall: (toolCall) => {
      summary.toolCallCount += 1;
      onPart(toolCall);
    },
  });
}

/**
 * Dispatches an array of parsed response parts to the appropriate callbacks.
 *
 * @param parts  - Parsed SSE response parts (text, reasoning, tool_call).
 * @param params - The callback collection from the active stream request.
 */
export function emitParts(
  parts: readonly NanoGptResponsePart[],
  params: {
    onText: (text: string) => void;
    onReasoning?: (text: string) => void;
    onToolCall?: (toolCall: Extract<NanoGptResponsePart, { type: "tool_call" }>) => void;
  },
): void {
  for (const part of parts) {
    if (part.type === "text") {
      params.onText(part.text);
    } else if (part.type === "reasoning") {
      params.onReasoning?.(part.text);
    } else {
      params.onToolCall?.(part);
    }
  }
}
