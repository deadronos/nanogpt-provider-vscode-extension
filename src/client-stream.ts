import { NanoGptSseParser, ABNORMAL_FINISH_REASONS } from "./nanogpt-parser.js";
import type { NanoGptResponsePart, NanoGptRequest } from "./nanogpt-types.js";
import { getHeader } from "./utils.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type StreamProcessingSummary = {
  chunkCount: number;
  textPartCount: number;
  reasoningPartCount: number;
  toolCallCount: number;
  /**
   * The last `finish_reason` seen in the SSE stream, if any.
   * Abnormal values (`"length"`, `"content_filter"`) indicate the
   * response was truncated or refused by the upstream provider.
   */
  finishReason?: string;
};

/** Minimal logger contract for stream-level logging. */
type StreamLogger = {
  debug(message: string): void;
  warn(message: string): void;
  trace(message: string): void;
};

/**
 * Default idle timeout for a single chunk read. If no data arrives
 * within this window, the stream is considered stalled and an error
 * is thrown. This is distinct from the global fetch timeout — it
 * resets on every successful chunk read.
 */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

// ── Streaming HTTP execution ────────────────────────────────────────────────

/**
 * Posts a chat completion request and processes the SSE response stream,
 * dispatching each parsed part to `onPart` and returning aggregate part counts.
 *
 * This is the core HTTP+SSE pipeline shared by native and bridge streaming.
 *
 * Features:
 * - Per-chunk idle timeout: if no data arrives within `idleTimeoutMs`,
 *   the stream is aborted and an error is thrown. This prevents silent
 *   hangs when the server stops sending but doesn't close the connection.
 * - finish_reason tracking: abnormal finish reasons (`"length"`,
 *   `"content_filter"`) are logged as warnings and exposed in the summary.
 */
export async function executeStreamingRequest(
  fetchImpl: typeof fetch,
  logger: StreamLogger,
  params: {
    request: NanoGptRequest;
    requestId: string;
    signal?: AbortSignal;
    onPart: (part: NanoGptResponsePart) => void;
    /**
     * Per-chunk idle timeout in milliseconds. If no data arrives within
     * this window, the stream read is aborted. Defaults to 60s.
     */
    idleTimeoutMs?: number;
  },
): Promise<StreamProcessingSummary> {
  const idleTimeoutMs = params.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
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
      const chunkResult = await readWithIdleTimeout(reader, idleTimeoutMs, params.signal, params.requestId, logger);
      if (chunkResult.done) {
        break;
      }

      summary.chunkCount += 1;
      buffer += decoder.decode(chunkResult.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      processStreamParts(parser.acceptLines(lines), params.onPart, summary);
    }

    buffer += decoder.decode();
    processStreamParts(parser.acceptLines(buffer.split(/\r?\n/)), params.onPart, summary);
    processStreamParts(parser.flushPendingToolCalls(), params.onPart, summary);

    summary.finishReason = parser.finishReason;
    if (summary.finishReason && ABNORMAL_FINISH_REASONS.has(summary.finishReason)) {
      logger.warn(
        `[${params.requestId}] chat stream ended with abnormal finish_reason="${summary.finishReason}" (chunks=${summary.chunkCount}, textParts=${summary.textPartCount}, toolCalls=${summary.toolCallCount})`,
      );
    }

    logger.trace(
      `[${params.requestId}] chat stream processed (chunks=${summary.chunkCount}, textParts=${summary.textPartCount}, reasoningParts=${summary.reasoningPartCount}, toolCalls=${summary.toolCallCount}, finishReason=${summary.finishReason ?? "none"})`,
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

/**
 * Reads a single chunk from the stream reader with an idle timeout.
 * If no data arrives within `idleTimeoutMs`, throws an error.
 * The timeout resets on each successful read.
 */
async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal: AbortSignal | undefined,
  requestId: string,
  logger: StreamLogger,
): Promise<{ done: true } | { done: false; value: Uint8Array }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timeoutReject: ((error: Error) => void) | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutReject = reject;
    timeoutId = setTimeout(() => {
      reject(new Error(`NanoGPT stream idle timeout: no data received for ${idleTimeoutMs}ms`));
    }, idleTimeoutMs);
  });

  // If already aborted, don't even start the read.
  if (signal?.aborted) {
    clearTimeout(timeoutId);
    throw new Error("NanoGPT stream aborted before read");
  }

  try {
    const result = await Promise.race([
      reader.read(),
      timeoutPromise,
    ]);
    return result as { done: true } | { done: false; value: Uint8Array };
  } catch (error) {
    // Distinguish idle timeout from abort from other errors for logging.
    if (error instanceof Error && error.message.includes("idle timeout")) {
      logger.warn(`[${requestId}] stream idle timeout after ${idleTimeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
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
