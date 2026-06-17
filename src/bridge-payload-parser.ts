import {
  type NanoGptBridgeToolCall,
  type NanoGptToolBridgeParseResult,
  type BridgeTurnPayload,
} from "./bridge-types.js";
import type { VscodeLikeTool } from "./nanogpt-types.js";
import { tryParseJson } from "./utils.js";
import { unwrapJsonCodeFence, extractXmlLikeToolCallPayload } from "./bridge-xml-parser.js";
import {
  extractTopLevelJsonValue,
  normalizeBridgeTurnPayload,
  normalizeBridgeMode,
  normalizeToolCallsContainer,
  normalizeToolCall,
  contentValueToText,
  buildKnownToolNameMap,
} from "./bridge-json-parser.js";

// ── Bridge response text normalisation ──────────────────────────────────────

function normalizeBridgeResponseText(text: string): string | undefined {
  const xmlLikePayload = extractXmlLikeToolCallPayload(text);
  if (xmlLikePayload) {
    return JSON.stringify(xmlLikePayload);
  }

  const candidates = [text.trim(), unwrapJsonCodeFence(text), extractTopLevelJsonValue(text)]
    .filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);

  for (const candidate of candidates) {
    const normalized = normalizeBridgeTurnPayload(tryParseJson(candidate) ?? candidate);
    if (normalized) {
      return JSON.stringify(normalized);
    }
  }

  return undefined;
}

// ── Public entry point ──────────────────────────────────────────────────────

export function parseToolCallingBridgeResponse(
  text: string,
  tools: readonly VscodeLikeTool[],
): NanoGptToolBridgeParseResult {
  const normalizedText = normalizeBridgeResponseText(text);
  if (!normalizedText) {
    return {
      kind: "invalid",
      errorCode: "missing_bridge_object_turn",
      message: "Tool-calling bridge response did not contain a usable JSON object.",
    };
  }

  const parsed = tryParseJson(normalizedText);
  const payload = normalizeBridgeTurnPayload(parsed);
  if (!payload) {
    return {
      kind: "invalid",
      errorCode: "invalid_json_turn",
      message: "Tool-calling bridge response was not valid JSON.",
    };
  }

  const knownNames = buildKnownToolNameMap(tools);
  const toolCalls = normalizeToolCallsContainer(payload.tool_calls).flatMap((candidate) => {
    const toolCall = normalizeToolCall(candidate, knownNames);
    return toolCall ? [toolCall] : [];
  });
  const content = contentValueToText(payload.message).trim();
  const mode = normalizeBridgeMode(payload.mode, toolCalls.length > 0);

  if (toolCalls.length > 0 || mode === "tool") {
    if (toolCalls.length === 0) {
      return {
        kind: "invalid",
        errorCode: "invalid_schema_turn",
        message: "Tool-calling bridge tool turn did not contain any usable tool calls.",
      };
    }

    return {
      kind: "tool_calls",
      content,
      toolCalls,
    };
  }

  if (content) {
    return {
      kind: "final",
      content,
    };
  }

  return {
    kind: "invalid",
    errorCode: "invalid_empty_turn",
    message: "Tool-calling bridge response did not contain visible text or usable tool calls.",
  };
}
