import { parseToolCallingBridgeResponse, buildNanoGptChatCompletionRequest, prepareChatRequest } from "./nanogpt.js";
import { buildToolCallingBridgeRepairMessages } from "./bridge-message-builder.js";
import type {
  NanoGptChatMessage,
  NanoGptReasoningEffort,
  NanoGptReasoningOutput,
  NanoGptResponsePart,
  NanoGptRoutingMode,
  NanoGptToolCallingStrategy,
  VscodeLikeTool,
} from "./nanogpt-types.js";
import { executeStreamingRequest, emitParts, type StreamProcessingSummary } from "./client-stream.js";
import type { NanoGptBridgeTelemetry } from "./client.js";

// ── Constants ───────────────────────────────────────────────────────────────

const BRIDGE_RAW_TEXT_FALLBACK_PREFIX =
  "Warning: NanoGPT bridge mode returned plain text instead of the required JSON tool-calling contract. Treating the raw reply below as a best-effort fallback.\n\n";

const REQUIRED_TOOL_MODE_FAILURE_TEXT =
  "NanoGPT could not complete this required-tool turn safely. The model failed to return a valid structured tool call, so no tools were executed. Please retry or use a different model/provider.";

// ── Types ───────────────────────────────────────────────────────────────────

type BridgeRepairReason = "invalid_response" | "required_tool_missing";

type BridgeTurnResult = {
  summary: StreamProcessingSummary;
  bridgeText: string;
  parsed: ReturnType<typeof parseToolCallingBridgeResponse>;
  requestId: string;
  reasoningChunks: string[];
};

/** Minimal logger contract for bridge-level logging. */
type BridgeLogger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  trace(message: string): void;
};

// ── Telemetry ───────────────────────────────────────────────────────────────

export function createEmptyBridgeTelemetry(): NanoGptBridgeTelemetry {
  return {
    bridgeRepairAttempts: 0,
    bridgeRepairSuccesses: 0,
    bridgeRawTextFallbacks: 0,
    bridgeRequiredFailClosed: 0,
  };
}

// ── Text analysis helpers ───────────────────────────────────────────────────

function normalizeRetryHeuristicText(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isLikelyToolScaffoldingText(text: string): boolean {
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

export function collectTextParts(parts: readonly NanoGptResponsePart[]): string {
  return parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

// ── Bridge retry heuristics ─────────────────────────────────────────────────

export function getAutoBridgeRetryReason(params: {
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

export function getBridgeRepairReason(params: {
  bridgeText: string;
  toolMode?: "auto" | "required";
  parsed: ReturnType<typeof parseToolCallingBridgeResponse>;
}): BridgeRepairReason | undefined {
  if (!params.bridgeText.trim()) {
    return undefined;
  }

  if (params.toolMode === "required" && params.parsed.kind !== "tool_calls") {
    return "required_tool_missing";
  }

  return params.parsed.kind === "invalid" ? "invalid_response" : undefined;
}

// ── Bridge streaming ───────────────────────────────────────────────────────

export async function executeBridgeTurn(
  fetchImpl: typeof fetch,
  logger: BridgeLogger,
  params: {
    apiKey: string;
    modelId: string;
    messages: readonly NanoGptChatMessage[];
    routingMode: NanoGptRoutingMode;
    provider?: string;
    maxTokens?: number;
    tools: readonly VscodeLikeTool[];
    reasoningEffort?: NanoGptReasoningEffort;
    reasoningOutput?: NanoGptReasoningOutput;
    signal?: AbortSignal;
    requestId: string;
  },
): Promise<BridgeTurnResult> {
  let bridgeText = "";
  const reasoningChunks: string[] = [];

  const summary = await executeStreamingRequest(fetchImpl, logger, {
    request: buildNanoGptChatCompletionRequest({
      apiKey: params.apiKey,
      modelId: params.modelId,
      messages: prepareChatRequest(params.messages),
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
        reasoningChunks.push(part.text);
      } else if (part.type === "text") {
        bridgeText += part.text;
      }
    },
  });

  return {
    summary,
    bridgeText,
    parsed: parseToolCallingBridgeResponse(bridgeText, params.tools),
    requestId: params.requestId,
    reasoningChunks,
  };
}

export function emitBridgeReasoning(
  reasoningChunks: readonly string[],
  onReasoning?: (text: string) => void,
): void {
  if (!onReasoning || reasoningChunks.length === 0) {
    return;
  }
  for (const chunk of reasoningChunks) {
    onReasoning(chunk);
  }
}

// ── Bridge orchestration ────────────────────────────────────────────────────

export type BridgeStreamParams = {
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
};

type BridgeStreamCallbacks = {
  onText: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolCall?: (toolCall: Extract<NanoGptResponsePart, { type: "tool_call" }>) => void;
};

export async function streamCompletionsViaBridge(
  fetchImpl: typeof fetch,
  logger: BridgeLogger,
  bridgeMessages: NanoGptChatMessage[],
  params: BridgeStreamParams,
  callbacks: BridgeStreamCallbacks,
): Promise<{
  bridgeTelemetry: NanoGptBridgeTelemetry;
  requiredToolWarning?: string;
  summary: StreamProcessingSummary;
}> {
  const tools = params.tools ?? [];
  const bridgeTelemetry = createEmptyBridgeTelemetry();
  let turn = await executeBridgeTurn(fetchImpl, logger, {
    ...params,
    tools,
    messages: bridgeMessages,
  });

  const repairReason = getBridgeRepairReason({
    bridgeText: turn.bridgeText,
    toolMode: params.toolMode,
    parsed: turn.parsed,
  });
  if (repairReason) {
    bridgeTelemetry.bridgeRepairAttempts += 1;
    logger.warn(
      `[${params.requestId}] tool-calling bridge response was non-compliant; retrying with a JSON-only repair turn`,
    );
    turn = await executeBridgeTurn(fetchImpl, logger, {
      ...params,
      tools,
      requestId: `${params.requestId}:repair`,
      messages: buildToolCallingBridgeRepairMessages({
        messages: bridgeMessages,
        invalidResponse: turn.bridgeText,
        toolMode: params.toolMode,
        repairReason,
      }),
    });
    if (turn.parsed.kind === "tool_calls" || turn.parsed.kind === "final") {
      bridgeTelemetry.bridgeRepairSuccesses += 1;
    }
  }

  if (turn.parsed.kind === "tool_calls") {
    emitBridgeReasoning(turn.reasoningChunks, callbacks.onReasoning);
    if (turn.parsed.content) {
      callbacks.onText(turn.parsed.content);
    }

    turn.parsed.toolCalls.forEach((toolCall, index) => {
      callbacks.onToolCall?.({
        type: "tool_call",
        callId: `bridge_call_${index + 1}`,
        name: toolCall.name,
        input: toolCall.input,
      });
    });

    return { summary: turn.summary, bridgeTelemetry };
  }

  if (params.toolMode === "required") {
    logger.warn(
      `[${params.requestId}] tool-calling bridge required a tool call but the model did not return one; failing closed`,
    );
    bridgeTelemetry.bridgeRequiredFailClosed += 1;
    return {
      summary: turn.summary,
      bridgeTelemetry,
      requiredToolWarning: REQUIRED_TOOL_MODE_FAILURE_TEXT,
    };
  }

  if (turn.parsed.kind === "final") {
    emitBridgeReasoning(turn.reasoningChunks, callbacks.onReasoning);
    callbacks.onText(turn.parsed.content);
    return { summary: turn.summary, bridgeTelemetry };
  }

  const fallbackBridgeText = turn.bridgeText.trim();
  if (turn.parsed.errorCode === "missing_bridge_object_turn" && fallbackBridgeText) {
    logger.warn(
      `[${turn.requestId}] tool-calling bridge response omitted JSON; falling back to raw text`,
    );
    bridgeTelemetry.bridgeRawTextFallbacks += 1;
    emitBridgeReasoning(turn.reasoningChunks, callbacks.onReasoning);
    callbacks.onText(BRIDGE_RAW_TEXT_FALLBACK_PREFIX + fallbackBridgeText);
    return { summary: turn.summary, bridgeTelemetry };
  }

  logger.warn(
    `[${turn.requestId}] tool-calling bridge response was invalid (${turn.parsed.errorCode})`,
  );
  throw new Error("NanoGPT tool-calling bridge response was invalid: " + turn.parsed.message);
}
