import {
  type NanoGptBridgeToolCall,
  type BridgeTurnPayload,
} from "./bridge-types.js";
import type { VscodeLikeTool } from "./nanogpt-types.js";
import { deepClone, tryParseJson } from "./utils.js";

// ── JSON extraction ─────────────────────────────────────────────────────────

export function extractTopLevelJsonValue(text: string): string | undefined {
  const source = String(text);
  let startIndex = -1;
  let openChar = "";

  for (let index = 0; index < source.length; index += 1) {
    const candidate = source[index];
    if (candidate === "{" || candidate === "[") {
      startIndex = index;
      openChar = candidate;
      break;
    }
  }

  if (startIndex < 0) {
    return undefined;
  }

  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const candidate = source[index];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (candidate === "\\") {
        escaping = true;
      } else if (candidate === '"') {
        inString = false;
      }
      continue;
    }

    if (candidate === '"') {
      inString = true;
      continue;
    }

    if (candidate === openChar) {
      depth += 1;
      continue;
    }

    if (candidate === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  return undefined;
}

// ── Bridge mode normalisation ───────────────────────────────────────────────

export function normalizeBridgeMode(mode: unknown, hasToolCalls: boolean): "tool" | "final" | "clarify" {
  const normalized = typeof mode === "string" ? mode.trim().toLowerCase() : "";

  if (["tool", "tools", "tool_call", "tool_calls", "call", "calls", "action"].includes(normalized)) {
    return "tool";
  }

  if (["clarify", "question", "ask", "needs_input", "input_required"].includes(normalized)) {
    return "clarify";
  }

  if (["final", "done", "complete", "completed", "response", "answer", "stop"].includes(normalized)) {
    return "final";
  }

  return hasToolCalls ? "tool" : "final";
}

// ── Content value extraction ────────────────────────────────────────────────

export function contentValueToText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (!part || typeof part !== "object") {
          return "";
        }
        if (typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        if (
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }

  if (typeof value === "object") {
    if (typeof (value as { text?: unknown }).text === "string") {
      return (value as { text: string }).text;
    }
    if (typeof (value as { message?: unknown }).message === "string") {
      return (value as { message: string }).message;
    }
    if (typeof (value as { content?: unknown }).content === "string") {
      return (value as { content: string }).content;
    }
  }

  return String(value);
}

// ── Tool argument / name normalisation ──────────────────────────────────────

export function normalizeToolArguments(value: unknown): object {
  if (value === null || value === undefined) {
    return {};
  }

  if (typeof value === "string") {
    const parsed = tryParseJson(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as object;
    }
    return value.trim() ? { input: value.trim() } : {};
  }

  if (typeof value === "object" && !Array.isArray(value)) {
     return deepClone(value);
  }

  if (Array.isArray(value)) {
    return { items: deepClone(value) };
  }

  return { value };
}

export function canonicalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function buildKnownToolNameMap(tools: readonly VscodeLikeTool[]): Map<string, string> {
  const knownNames = new Map<string, string>();

  for (const tool of tools) {
    const canonical = canonicalizeToolName(tool.name);
    if (canonical && !knownNames.has(canonical)) {
      knownNames.set(canonical, tool.name);
    }
  }

  return knownNames;
}

export function resolveToolName(name: unknown, knownNames: ReadonlyMap<string, string>): string | undefined {
  if (typeof name !== "string" || !name.trim()) {
    return undefined;
  }

  return knownNames.get(canonicalizeToolName(name)) ?? name.trim();
}

// ── Tool-call container / individual normalisation ──────────────────────────

export function normalizeToolCallsContainer(value: unknown): unknown[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (typeof value === "string") {
    const parsed = tryParseJson(value);
    return parsed === undefined ? [] : normalizeToolCallsContainer(parsed);
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "object") {
    const nested = (value as BridgeTurnPayload).tool_calls ?? (value as BridgeTurnPayload).toolCalls;
    if (nested !== undefined && nested !== value) {
      return normalizeToolCallsContainer(nested);
    }
    return [value];
  }

  return [];
}

export function normalizeToolCall(
  candidate: unknown,
  knownNames: ReadonlyMap<string, string>,
): NanoGptBridgeToolCall | undefined {
  const parsedCandidate = typeof candidate === "string" ? tryParseJson(candidate) ?? candidate : candidate;
  if (!parsedCandidate || typeof parsedCandidate !== "object" || Array.isArray(parsedCandidate)) {
    return undefined;
  }

  const functionPayload =
    parsedCandidate &&
    typeof (parsedCandidate as BridgeTurnPayload).function === "object" &&
    !Array.isArray((parsedCandidate as BridgeTurnPayload).function)
      ? ((parsedCandidate as BridgeTurnPayload).function as BridgeTurnPayload)
      : undefined;

  const rawName =
    (parsedCandidate as BridgeTurnPayload).name ??
    functionPayload?.name;

  const resolvedName = resolveToolName(rawName, knownNames);
  if (!resolvedName) {
    return undefined;
  }

  const argsSource =
    (parsedCandidate as BridgeTurnPayload).arguments ??
    (parsedCandidate as BridgeTurnPayload).args ??
    (parsedCandidate as BridgeTurnPayload).parameters ??
    (parsedCandidate as BridgeTurnPayload).input ??
    functionPayload?.arguments ??
    functionPayload?.args ??
    functionPayload?.parameters ??
    functionPayload?.input;

  const input = normalizeToolArguments(argsSource);
  const flattened = { ...(input as Record<string, unknown>) };
  const usedFlattenedArgsFallback = argsSource === undefined;
  const skipKeys = new Set([
    "name",
    "tool_name",
    "toolName",
    "arguments",
    "args",
    "parameters",
    "params",
    "input",
    "function",
    "type",
    "id",
  ]);

  for (const [key, value] of Object.entries(parsedCandidate)) {
    const shouldPreserveFlattenedFallbackKey = usedFlattenedArgsFallback && ["id", "type"].includes(key);
    if ((shouldPreserveFlattenedFallbackKey || !skipKeys.has(key)) && !(key in flattened)) {
      flattened[key] = value;
    }
  }

  return {
    name: resolvedName,
    input: flattened,
  };
}

// ── Bridge turn payload normalisation ───────────────────────────────────────

export function normalizeBridgeTurnPayload(value: unknown, depth = 0): BridgeTurnPayload | undefined {
  if (depth > 5 || value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    const parsed = tryParseJson(value);
    return parsed === undefined ? undefined : normalizeBridgeTurnPayload(parsed, depth + 1);
  }

  if (Array.isArray(value)) {
    return value.length > 0
      ? { v: 1, mode: "tool", message: "", tool_calls: value }
      : undefined;
  }

  if (typeof value !== "object") {
    return undefined;
  }

  const candidate = value as BridgeTurnPayload;
  for (const key of ["assistant", "response", "turn", "result", "output", "payload", "data"] as const) {
    const nested = candidate[key];
    if (nested !== undefined) {
      const normalized = normalizeBridgeTurnPayload(nested, depth + 1);
      if (normalized) {
        if (!normalized.message) {
          normalized.message = candidate.message ?? candidate.output;
        }
        return normalized;
      }
    }
  }

  const toolCalls = normalizeToolCallsContainer(candidate.tool_calls ?? candidate.toolCalls);
  if (toolCalls.length === 0 && (candidate.name || candidate.function)) {
    toolCalls.push(candidate);
  }

  const rawMode = candidate.mode;
  const message = contentValueToText(candidate.message ?? candidate.output ?? candidate.result).trim();
  if (toolCalls.length === 0 && !message && rawMode === undefined) {
    return undefined;
  }

  return {
    v: candidate.v ?? 1,
    mode: normalizeBridgeMode(rawMode, toolCalls.length > 0),
    message,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}
