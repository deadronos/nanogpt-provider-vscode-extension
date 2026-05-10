import {
  buildNanoGptChatCompletionRequest,
  buildToolCallingBridgeMessages,
  NANOGPT_BASE_URL,
  NANOGPT_SUBSCRIPTION_BASE_URL,
  NanoGptSseParser,
  mapNanoGptModelsToVscode,
  type NanoGptChatMessage,
  type NanoGptReasoningEffort,
  type NanoGptReasoningOutput,
  type NanoGptResponsePart,
  type NanoGptRoutingMode,
  type NanoGptToolCallingStrategy,
  type VscodeLikeTool,
  type VscodeModelMetadata,
  parseToolCallingBridgeResponse,
} from "./nanogpt.js";
import { getHeader, withTimeout, type ManagedAbortSignal } from "./utils.js";

type FetchLike = typeof fetch;

export type NanoGptLogger = {
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

const NOOP_LOGGER: NanoGptLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Generous timeout for the full SSE lifetime of a streaming chat completion.
 * Streaming responses for long outputs can take several minutes; 30 s is far
 * too short. This acts only as a safety-net for truly hung connections —
 * normal cancellation is handled by the VS Code CancellationToken.
 */
const STREAM_FETCH_TIMEOUT_MS = 5 * 60_000;

const BRIDGE_RAW_TEXT_FALLBACK_PREFIX =
  "Warning: NanoGPT bridge mode returned plain text instead of the required JSON tool-calling contract. Treating the raw reply below as a best-effort fallback.\n\n";

type StreamProcessingSummary = {
  chunkCount: number;
  textPartCount: number;
  reasoningPartCount: number;
  toolCallCount: number;
};

function normalizeRetryHeuristicText(text: string): string {
  return text.replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

function isLikelyToolScaffoldingText(text: string): boolean {
  const normalized = normalizeRetryHeuristicText(text);
  if (!normalized || normalized.length > 240) {
    return false;
  }

  const sentenceCount = normalized
    .split(/[.!?]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean).length;
  if (sentenceCount > 2) {
    return false;
  }

  const startsLikeScaffolding =
    /^(?:ok(?:ay)?[, ]+|sure[, ]+|alright[, ]+|first[, ]+|to start[, ]+|let me\b|i(?:'m| am)\b|i(?:'ll| will)\b)/.test(
      normalized,
    );
  const hasInspectionVerb =
    /\b(?:read|reading|check|checking|inspect|inspecting|review|reviewing|look|looking|search|searching|trace|tracing|examine|examining|investigate|investigating|scan|scanning|open|opening|load|loading|analyze|analyzing|analyse|analysing|debug|debugging|explore|exploring|find|finding|start|starting|begin|beginning)\b/.test(
      normalized,
    );

  return startsLikeScaffolding && hasInspectionVerb;
}

function collectTextParts(parts: readonly NanoGptResponsePart[]): string {
  return parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function getAutoBridgeRetryReason(params: {
  hasTools: boolean;
  toolCallingStrategy: NanoGptToolCallingStrategy;
  nativeSummary: StreamProcessingSummary;
  nativeText: string;
  aborted: boolean;
}): "empty" | "scaffolding" | undefined {
  if (
    params.toolCallingStrategy !== "auto" ||
    !params.hasTools ||
    params.aborted ||
    params.nativeSummary.toolCallCount > 0
  ) {
    return undefined;
  }

  if (params.nativeSummary.textPartCount === 0) {
    return "empty";
  }

  return isLikelyToolScaffoldingText(params.nativeText) ? "scaffolding" : undefined;
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
  private readonly logger: NanoGptLogger;

  /**
   * @param fetchImpl - Custom fetch implementation (defaults to global `fetch`).
   *                    Used for injecting mock responses in tests.
   */
  constructor(fetchImpl: FetchLike = fetch, logger: NanoGptLogger = NOOP_LOGGER) {
    this.fetchImpl = fetchImpl;
    this.logger = logger;
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
    requestId?: string;
  }): Promise<VscodeModelMetadata[]> {
    const baseUrl =
      params.routingMode === "subscription" ? NANOGPT_SUBSCRIPTION_BASE_URL : NANOGPT_BASE_URL;
    const url = new URL(`${baseUrl}/models`);
    url.searchParams.set("detailed", "true");
    const requestId = params.requestId ?? "discovery";

    this.logger.debug(
      `[${requestId}] HTTP GET ${url.pathname}${url.search} (routingMode=${params.routingMode}, allowlistCount=${params.allowlist?.length ?? 0})`,
    );

    const timeoutSignal = withTimeout(params.signal, DEFAULT_FETCH_TIMEOUT_MS);

    try {
      const response = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          Accept: "application/json",
        },
        signal: timeoutSignal.signal,
      });

      this.logger.debug(
        `[${requestId}] model discovery response received (status=${response.status}, contentType=${getHeader(response, "content-type")})`,
      );

      if (!response.ok) {
        throw new Error("NanoGPT model discovery failed with HTTP " + response.status);
      }

      const payload = (await response.json()) as unknown;
      const entries = Array.isArray(payload)
        ? payload
        : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
          ? (payload as { data: unknown[] }).data
          : [];

      this.logger.trace(
        `[${requestId}] model discovery payload parsed (entryCount=${entries.length})`,
      );

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
    toolCallingStrategy?: NanoGptToolCallingStrategy;
    parallelToolCalls?: boolean;
    signal?: AbortSignal;
    requestId?: string;
    onText: (text: string) => void;
    onReasoning?: (text: string) => void;
    onToolCall?: (toolCall: Extract<NanoGptResponsePart, { type: "tool_call" }>) => void;
  }): Promise<void> {
    const requestId = params.requestId ?? "chat";

    this.logger.debug(
      `[${requestId}] HTTP POST /chat/completions (routingMode=${params.routingMode}, provider=${params.provider?.trim() || "default"}, maxTokens=${params.maxTokens ?? "default"}, toolCount=${params.tools?.length ?? 0}, toolMode=${params.toolMode ?? "default"}, reasoningEffort=${params.reasoningEffort ?? "auto"}, reasoningOutput=${params.reasoningOutput ?? "native"}, toolCallingStrategy=${params.toolCallingStrategy ?? "auto"}, parallelToolCalls=${Boolean(params.parallelToolCalls)}, messageCount=${params.messages.length})`,
    );

    const timeoutSignal = withTimeout(params.signal, STREAM_FETCH_TIMEOUT_MS);

    try {
      const toolCallingStrategy = params.toolCallingStrategy ?? "auto";
      const hasTools = Boolean(params.tools?.length);
      const shouldBufferNativeTurn = toolCallingStrategy === "auto" && hasTools;
      const bufferedNativeParts: NanoGptResponsePart[] = [];

      if (toolCallingStrategy === "bridge" && hasTools) {
        await this.streamChatCompletionsViaBridge({
          ...params,
          signal: timeoutSignal.signal,
          requestId,
        });
        return;
      }

      const nativeSummary = await this.streamNativeChatCompletions({
        ...params,
        signal: timeoutSignal.signal,
        requestId,
        onText: shouldBufferNativeTurn
          ? (text) => bufferedNativeParts.push({ type: "text", text })
          : params.onText,
        onReasoning: shouldBufferNativeTurn
          ? (text) => bufferedNativeParts.push({ type: "reasoning", text })
          : params.onReasoning,
        onToolCall: shouldBufferNativeTurn
          ? (toolCall) => bufferedNativeParts.push(toolCall)
          : params.onToolCall,
      });

      const bridgeRetryReason = getAutoBridgeRetryReason({
        hasTools,
        toolCallingStrategy,
        nativeSummary,
        nativeText: collectTextParts(bufferedNativeParts),
        aborted: timeoutSignal.signal.aborted,
      });
      if (bridgeRetryReason) {
        const retryReasonMessage =
          bridgeRetryReason === "empty"
            ? "no text or tool calls"
            : "likely scaffolding text without tool calls";
        this.logger.warn(
          `[${requestId}] native tool-calling produced ${retryReasonMessage}; retrying with bridge mode`,
        );
        await this.streamChatCompletionsViaBridge({
          ...params,
          signal: timeoutSignal.signal,
          requestId: `${requestId}:bridge`,
        });
        return;
      }

      if (shouldBufferNativeTurn) {
        this.emitParts(bufferedNativeParts, params);
      }
    } finally {
      timeoutSignal.dispose();
    }
  }

  private async streamNativeChatCompletions(params: {
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
    requestId: string;
    onText: (text: string) => void;
    onReasoning?: (text: string) => void;
    onToolCall?: (toolCall: Extract<NanoGptResponsePart, { type: "tool_call" }>) => void;
  }): Promise<StreamProcessingSummary> {
    return this.executeStreamingRequest({
      request: buildNanoGptChatCompletionRequest({
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
      }),
      requestId: params.requestId,
      signal: params.signal,
      onPart: (part) => this.emitParts([part], params),
    });
  }

  private async streamChatCompletionsViaBridge(params: {
    apiKey: string;
    modelId: string;
    messages: readonly NanoGptChatMessage[];
    routingMode: NanoGptRoutingMode;
    provider?: string;
    maxTokens?: number;
    tools?: readonly VscodeLikeTool[];
    reasoningEffort?: NanoGptReasoningEffort;
    reasoningOutput?: NanoGptReasoningOutput;
    parallelToolCalls?: boolean;
    signal?: AbortSignal;
    requestId: string;
    onText: (text: string) => void;
    onReasoning?: (text: string) => void;
    onToolCall?: (toolCall: Extract<NanoGptResponsePart, { type: "tool_call" }>) => void;
  }): Promise<StreamProcessingSummary> {
    const tools = params.tools ?? [];
    const bridgeMessages = buildToolCallingBridgeMessages({
      messages: params.messages,
      tools,
      parallelToolCalls: params.parallelToolCalls,
    });
    let bridgeText = "";

    const summary = await this.executeStreamingRequest({
      request: buildNanoGptChatCompletionRequest({
        apiKey: params.apiKey,
        modelId: params.modelId,
        messages: bridgeMessages,
        routingMode: params.routingMode,
        provider: params.provider,
        maxTokens: params.maxTokens,
        reasoningEffort: params.reasoningEffort,
        reasoningOutput: params.reasoningOutput,
      }),
      requestId: params.requestId,
      signal: params.signal,
      onPart: (part) => {
        if (part.type === "reasoning") {
          params.onReasoning?.(part.text);
        } else if (part.type === "text") {
          bridgeText += part.text;
        }
      },
    });

    const parsed = parseToolCallingBridgeResponse(bridgeText, tools);
    if (parsed.kind === "tool_calls") {
      if (parsed.content) {
        params.onText(parsed.content);
      }

      parsed.toolCalls.forEach((toolCall, index) => {
        params.onToolCall?.({
          type: "tool_call",
          callId: `bridge_call_${index + 1}`,
          name: toolCall.name,
          input: toolCall.input,
        });
      });

      return summary;
    }

    if (parsed.kind === "final") {
      params.onText(parsed.content);
      return summary;
    }

    const fallbackBridgeText = bridgeText.trim();
    if (parsed.errorCode === "missing_bridge_object_turn" && fallbackBridgeText) {
      this.logger.warn(
        `[${params.requestId}] tool-calling bridge response omitted JSON; falling back to raw text`,
      );
      params.onText(BRIDGE_RAW_TEXT_FALLBACK_PREFIX + fallbackBridgeText);
      return summary;
    }

    this.logger.warn(
      `[${params.requestId}] tool-calling bridge response was invalid (${parsed.errorCode})`,
    );
    throw new Error("NanoGPT tool-calling bridge response was invalid: " + parsed.message);
  }

  private async executeStreamingRequest(params: {
    request: ReturnType<typeof buildNanoGptChatCompletionRequest>;
    requestId: string;
    signal?: AbortSignal;
    onPart: (part: NanoGptResponsePart) => void;
  }): Promise<StreamProcessingSummary> {
    const response = await this.fetchImpl(params.request.url, {
      method: "POST",
      headers: params.request.headers,
      body: params.request.body,
      signal: params.signal,
    });

    this.logger.debug(
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
      this.logger.warn(`[${params.requestId}] chat response had no body`);
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
        this.processStreamParts(parser.acceptLines(lines), params.onPart, summary);
      }

      buffer += decoder.decode();
      this.processStreamParts(parser.acceptLines(buffer.split(/\r?\n/)), params.onPart, summary);
      this.processStreamParts(parser.flushPendingToolCalls(), params.onPart, summary);
      this.logger.trace(
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

  private processStreamParts(
    parts: readonly NanoGptResponsePart[],
    onPart: (part: NanoGptResponsePart) => void,
    summary: StreamProcessingSummary,
  ): void {
    for (const part of parts) {
      if (part.type === "text") {
        summary.textPartCount += 1;
      } else if (part.type === "reasoning") {
        summary.reasoningPartCount += 1;
      } else {
        summary.toolCallCount += 1;
      }

      onPart(part);
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
