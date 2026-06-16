import {
  buildNanoGptChatCompletionRequest,
  buildToolCallingBridgeMessages,
  NANOGPT_BASE_URL,
  NANOGPT_SUBSCRIPTION_BASE_URL,
  mapNanoGptModelsToVscode,
  prepareChatRequest,
  type NanoGptChatMessage,
  type NanoGptReasoningEffort,
  type NanoGptReasoningOutput,
  type NanoGptResponsePart,
  type NanoGptRoutingMode,
  type NanoGptToolCallingStrategy,
  type VscodeLikeTool,
  type VscodeModelMetadata,
} from "./nanogpt.js";
import { withTimeout, formatKeyValuePairs, getHeader, type ManagedAbortSignal } from "./utils.js";
import { executeStreamingRequest, emitParts, type StreamProcessingSummary } from "./client-stream.js";
import {
  isLikelyToolScaffoldingText,
  collectTextParts,
  getAutoBridgeRetryReason,
  createEmptyBridgeTelemetry,
  streamCompletionsViaBridge,
} from "./client-bridge.js";

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

export type NanoGptBridgeTelemetry = {
  bridgeRepairAttempts: number;
  bridgeRepairSuccesses: number;
  bridgeRawTextFallbacks: number;
  bridgeRequiredFailClosed: number;
};

export type NanoGptChatStreamResult = {
  bridgeTelemetry: NanoGptBridgeTelemetry;
  requiredToolWarning?: string;
  /**
   * Aggregate part counts from the turn that produced the user-visible
   * response. For native turns this is the native stream summary; for
   * bridge turns (including `auto` retries) it is the final bridge
   * turn's summary. Exposed so the caller can log bridge-turn part
   * counts with the same fidelity as native turns.
   */
  summary: StreamProcessingSummary;
};

/**
 * Core parameters shared across all streaming chat completion methods.
 * Each method extends this with tool/callback/toolCallingStrategy fields
 * as needed.
 */
type StreamRequestCore = {
  apiKey: string;
  modelId: string;
  messages: readonly NanoGptChatMessage[];
  routingMode: NanoGptRoutingMode;
  provider?: string;
  maxTokens?: number;
  reasoningEffort?: NanoGptReasoningEffort;
  reasoningOutput?: NanoGptReasoningOutput;
  signal?: AbortSignal;
  requestId: string;
};

  type StreamCallbacks = {
    onText: (text: string) => void;
    onReasoning?: (text: string) => void;
    onToolCall?: (toolCall: Extract<NanoGptResponsePart, { type: "tool_call" }>) => void;
  };

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

      if (!Array.isArray(payload) && entries.length === 0) {
        this.logger.warn(
          `[${requestId}] model discovery payload had unexpected shape; treating it as empty`,
        );
      }

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
  }): Promise<NanoGptChatStreamResult> {
    const requestId = params.requestId ?? "chat";

    this.logger.debug(
      `[${requestId}] HTTP POST /chat/completions (routingMode=${params.routingMode}, provider=${params.provider?.trim() || "default"}, maxTokens=${params.maxTokens ?? "default"}, toolCount=${params.tools?.length ?? 0}, toolMode=${params.toolMode ?? "default"}, reasoningEffort=${params.reasoningEffort ?? "auto"}, reasoningOutput=${params.reasoningOutput ?? "native"}, toolCallingStrategy=${params.toolCallingStrategy ?? "native"}, parallelToolCalls=${Boolean(params.parallelToolCalls)}, messageCount=${params.messages.length})`,
    );

    const timeoutSignal = withTimeout(params.signal, STREAM_FETCH_TIMEOUT_MS);

    try {
      const toolCallingStrategy = params.toolCallingStrategy ?? "native";
      const hasTools = Boolean(params.tools?.length);
      // When tools are present in `native` or `auto` mode, buffer the entire
      // native turn before emitting anything. This serves two purposes:
      //  - `auto`: the buffered turn can be inspected and, if it produced no
      //    tool calls and only low-signal scaffolding text, retried once via
      //    the bridge path without the scaffolding leaking to the user.
      //  - `native`: thin scaffolding preambles (e.g. "Let me gather related
      //    files..") that precede real tool calls can be suppressed so they
      //    do not trigger VS Code's Copilot Chat loop-detection guard on BYOK
      //    streams.
      // In `bridge` mode the native stream is never started; the bridge path
      // owns emission. In tool-less turns nothing is buffered and parts are
      // emitted directly for lowest latency.
      const shouldBufferNativeTurn =
        hasTools && (toolCallingStrategy === "auto" || toolCallingStrategy === "native");
      const bufferedNativeParts: NanoGptResponsePart[] = [];

      if (toolCallingStrategy === "bridge" && hasTools) {
          const bridgeMessages = buildToolCallingBridgeMessages({
            messages: params.messages,
            tools: params.tools ?? [],
            toolMode: params.toolMode,
            parallelToolCalls: params.parallelToolCalls,
          });
          const bridgeResult = await streamCompletionsViaBridge(
            this.fetchImpl,
            this.logger,
            bridgeMessages,
            {
              ...params,
              signal: timeoutSignal.signal,
              requestId,
            },
            {
              onText: params.onText,
              onReasoning: params.onReasoning,
              onToolCall: params.onToolCall,
            },
          );
        return {
          bridgeTelemetry: bridgeResult.bridgeTelemetry,
          requiredToolWarning: bridgeResult.requiredToolWarning,
          summary: bridgeResult.summary,
        };
      }

      const nativeSummary = await this.streamNativeChatCompletions({
        ...params,
        signal: timeoutSignal.signal,
        requestId,
        onText: shouldBufferNativeTurn
           ? (text: string) => bufferedNativeParts.push({ type: "text", text })
          : params.onText,
        onReasoning: shouldBufferNativeTurn
           ? (text: string) => bufferedNativeParts.push({ type: "reasoning", text })
          : params.onReasoning,
        onToolCall: shouldBufferNativeTurn
           ? (toolCall: NanoGptResponsePart & { type: "tool_call" }) => bufferedNativeParts.push(toolCall)
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
        const bridgeRetryMessages = buildToolCallingBridgeMessages({
          messages: params.messages,
          tools: params.tools ?? [],
          toolMode: params.toolMode,
          parallelToolCalls: params.parallelToolCalls,
        });
        const bridgeResult = await streamCompletionsViaBridge(
          this.fetchImpl,
          this.logger,
          bridgeRetryMessages,
          {
            ...params,
            signal: timeoutSignal.signal,
            requestId: `${requestId}:bridge`,
          },
          {
            onText: params.onText,
            onReasoning: params.onReasoning,
            onToolCall: params.onToolCall,
          },
        );
        return {
          bridgeTelemetry: bridgeResult.bridgeTelemetry,
          requiredToolWarning: bridgeResult.requiredToolWarning,
          summary: bridgeResult.summary,
        };
      }

      // In native mode with tools, suppress thin scaffolding text that
      // appeared before tool calls. The preamble (e.g. "Let me check the
      // files..") adds no value and can trigger VS Code's Copilot Chat
      // loop-detection guard on BYOK streams.
      if (shouldBufferNativeTurn) {
        const hasToolCalls = nativeSummary.toolCallCount > 0;
        const shouldSuppressScaffolding =
          hasToolCalls &&
          isLikelyToolScaffoldingText(collectTextParts(bufferedNativeParts));
        if (shouldSuppressScaffolding) {
          this.logger.info(
            `[${requestId}] suppressed scaffolding text before tool calls (${formatKeyValuePairs({
              chars: collectTextParts(bufferedNativeParts).length,
            })})`,
          );
          // Emit only the tool calls (and any reasoning), drop the scaffolding text.
            emitParts(
            bufferedNativeParts.filter((part) => part.type !== "text"),
            params,
          );
        } else {
            emitParts(bufferedNativeParts, params);
        }
      }

      return { bridgeTelemetry: createEmptyBridgeTelemetry(), summary: nativeSummary };
    } finally {
      timeoutSignal.dispose();
    }
  }

  private async streamNativeChatCompletions(params: {
      tools?: readonly VscodeLikeTool[];
      toolMode?: "auto" | "required";
      parallelToolCalls?: boolean;
    } & StreamRequestCore & StreamCallbacks): Promise<StreamProcessingSummary> {
      return executeStreamingRequest(this.fetchImpl, this.logger, {
      request: buildNanoGptChatCompletionRequest({
        apiKey: params.apiKey,
        modelId: params.modelId,
          messages: prepareChatRequest(params.messages, this.logger),
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
        onPart: (part) => emitParts([part], params),
    });
  }

}
