import {
  buildNanoGptChatCompletionRequest,
  NANOGPT_BASE_URL,
  NANOGPT_SUBSCRIPTION_BASE_URL,
  NanoGptSseParser,
  mapNanoGptModelsToVscode,
  type NanoGptChatMessage,
  type NanoGptReasoningEffort,
  type NanoGptReasoningOutput,
  type NanoGptResponsePart,
  type NanoGptRoutingMode,
  type VscodeLikeTool,
  type VscodeModelMetadata,
} from "./nanogpt.js";

type FetchLike = typeof fetch;

type ManagedAbortSignal = {
  signal: AbortSignal;
  dispose(): void;
};

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Generous timeout for the full SSE lifetime of a streaming chat completion.
 * Streaming responses for long outputs can take several minutes; 30 s is far
 * too short. This acts only as a safety-net for truly hung connections —
 * normal cancellation is handled by the VS Code CancellationToken.
 */
const STREAM_FETCH_TIMEOUT_MS = 5 * 60_000;

/**
 * Combines an optional caller-provided abort signal with a fixed timeout,
 * returning a single signal that aborts when either triggers.
 *
 * Uses manual {@link AbortController} composition so the extension does not
 * depend on newer `AbortSignal.timeout()` or `AbortSignal.any()` helpers.
 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): ManagedAbortSignal {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
  }, timeoutMs);

  if (signal) {
    const onAbort = () => controller.abort((signal as AbortSignal & { reason?: unknown }).reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      controller.abort((signal as AbortSignal & { reason?: unknown }).reason);
    }

    return {
      signal: controller.signal,
      dispose() {
        clearTimeout(timeoutId);
        signal.removeEventListener("abort", onAbort);
      },
    };
  }

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeoutId);
    },
  };
}

/**
 * HTTP client for NanoGPT API endpoints.
 *
 * Handles model discovery (GET /models?detailed=true) and streaming
 * chat completions (POST /chat/completions) with configurable routing
 * between subscription and pay-as-you-go surfaces.
 *
 * Accepts an optional `fetchImpl` parameter for dependency injection
 * in unit tests.
 */
export class NanoGptClient {
  private readonly fetchImpl: FetchLike;

  /**
   * @param fetchImpl - Custom fetch implementation (defaults to global `fetch`).
   *                    Used for injecting mock responses in tests.
   */
  constructor(fetchImpl: FetchLike = fetch) {
    this.fetchImpl = fetchImpl;
  }

  /**
   * Fetches the available NanoGPT model catalog from the API.
   *
   * Requests detailed model metadata (`?detailed=true`). Parses the
   * response expecting either a flat array or a `{ data: [...] }` wrapper.
   * Models are then mapped to VS Code's {@link VscodeModelMetadata} shape.
   *
   * @param params.apiKey      - NanoGPT API Bearer token.
   * @param params.routingMode - Chooses subscription vs. paygo base URL.
   * @param params.allowlist   - Optional set of model IDs to filter by.
   * @param params.signal      - Optional cancellation signal.
   * @returns A list of models mapped to VS Code metadata format.
   * @throws If the HTTP response is not OK.
   */
  async discoverModels(params: {
    apiKey: string;
    routingMode: NanoGptRoutingMode;
    allowlist?: readonly string[];
    signal?: AbortSignal;
  }): Promise<VscodeModelMetadata[]> {
    const baseUrl =
      params.routingMode === "subscription" ? NANOGPT_SUBSCRIPTION_BASE_URL : NANOGPT_BASE_URL;
    const url = new URL(`${baseUrl}/models`);
    url.searchParams.set("detailed", "true");

    const timeoutSignal = withTimeout(params.signal, DEFAULT_FETCH_TIMEOUT_MS);

    try {
      const response = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          Accept: "application/json",
        },
        signal: timeoutSignal.signal,
      });

      if (!response.ok) {
        throw new Error("NanoGPT model discovery failed with HTTP " + response.status);
      }

      const payload = (await response.json()) as unknown;
      const entries = Array.isArray(payload)
        ? payload
        : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
          ? (payload as { data: unknown[] }).data
          : [];

      return mapNanoGptModelsToVscode(entries, params.allowlist);
    } finally {
      timeoutSignal.dispose();
    }
  }

  /**
   * Streams a chat completion from NanoGPT via SSE and dispatches
   * text, reasoning, and tool-call parts to the corresponding callbacks.
   *
   * Constructs the request via {@link buildNanoGptChatCompletionRequest},
   * then reads the response body as a byte stream, feeding lines into
   * the SSE parser. The parser emits typed parts that are forwarded
   * to the caller's `onText`, `onReasoning`, and `onToolCall` handlers.
   *
   * @param params.apiKey           - NanoGPT API Bearer token.
   * @param params.modelId          - The model identifier to use.
   * @param params.messages         - The conversation history.
   * @param params.routingMode      - Subscription or paygo routing.
   * @param params.provider         - Optional upstream provider for paygo mode.
   * @param params.maxTokens        - Optional max output tokens.
   * @param params.tools            - Optional tool definitions.
   * @param params.toolMode         - Tool selection mode ("auto" | "required").
   * @param params.reasoningEffort  - Optional reasoning effort control.
   * @param params.reasoningOutput  - How to surface reasoning in VS Code.
   * @param params.parallelToolCalls - Enable parallel tool calling.
   * @param params.signal           - Optional cancellation signal.
   * @param params.onText           - Callback for each text delta.
   * @param params.onReasoning      - Optional callback for reasoning deltas.
   * @param params.onToolCall       - Optional callback for completed tool calls.
   * @throws If the HTTP response is not OK (includes parsed NanoGPT error body).
   */
  async streamChatCompletions(params: {
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
    signal?: AbortSignal;
    onText: (text: string) => void;
    onReasoning?: (text: string) => void;
    onToolCall?: (toolCall: Extract<NanoGptResponsePart, { type: "tool_call" }>) => void;
  }): Promise<void> {
    const request = buildNanoGptChatCompletionRequest({
      apiKey: params.apiKey,
      modelId: params.modelId,
      messages: params.messages,
      routingMode: params.routingMode,
      provider: params.provider,
      maxTokens: params.maxTokens,
      tools: params.tools,
      toolMode: params.toolMode,
      reasoningEffort: params.reasoningEffort,
      reasoningOutput: params.reasoningOutput,
      parallelToolCalls: params.parallelToolCalls,
    });

    const timeoutSignal = withTimeout(params.signal, STREAM_FETCH_TIMEOUT_MS);

    try {
      const response = await this.fetchImpl(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: timeoutSignal.signal,
      });

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
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new NanoGptSseParser();
      let buffer = "";

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";

          this.emitParts(parser.acceptLines(lines), params);
        }

        buffer += decoder.decode();
        this.emitParts(parser.acceptLines(buffer.split(/\r?\n/)), params);
      } finally {
        reader.releaseLock();
      }
    } finally {
      timeoutSignal.dispose();
    }
  }

  /**
   * Dispatches an array of parsed response parts to the appropriate callbacks.
   *
   * @param parts  - Parsed SSE response parts (text, reasoning, tool_call).
   * @param params - The callback collection from the active stream request.
   */
  private emitParts(
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
}
