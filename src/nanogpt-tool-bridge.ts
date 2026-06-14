import {
  type NanoGptChatMessage,
  type NanoGptMessageContent,
  type VscodeLikeTool,
} from "./nanogpt-types.js";

export type NanoGptBridgeToolCall = {
  name: string;
  input: object;
};

export type NanoGptToolBridgeParseResult =
  | { kind: "final"; content: string }
  | { kind: "tool_calls"; content: string; toolCalls: NanoGptBridgeToolCall[] }
  | { kind: "invalid"; errorCode: string; message: string };

type BridgeTurnPayload = {
  v?: unknown;
  mode?: unknown;
  message?: unknown;
  tool_calls?: unknown;
  toolCalls?: unknown;
  response?: unknown;
  result?: unknown;
  output?: unknown;
  payload?: unknown;
  data?: unknown;
  assistant?: unknown;
  turn?: unknown;
  name?: unknown;
  function?: unknown;
  arguments?: unknown;
  args?: unknown;
  parameters?: unknown;
  input?: unknown;
};

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function contentToText(content: NanoGptMessageContent): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function cloneSchema<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildToolManifest(tools: readonly VscodeLikeTool[]): Array<{
  name: string;
  description: string;
  parameters: object;
  required: string[];
}> {
  return tools.map((tool) => {
    const schema = tool.inputSchema && typeof tool.inputSchema === "object"
      ? cloneSchema(tool.inputSchema)
      : { type: "object", properties: {} };

    const required = Array.isArray((schema as { required?: unknown }).required)
      ? (schema as { required: unknown[] }).required.filter(
          (item): item is string => typeof item === "string",
        )
      : [];

    return {
      name: tool.name,
      description: tool.description,
      parameters: schema,
      required,
    };
  });
}

function buildToolCallNameMap(messages: readonly NanoGptChatMessage[]): Map<string, string> {
  const byId = new Map<string, string>();

  for (const message of messages) {
    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.id && toolCall.function.name) {
        byId.set(toolCall.id, toolCall.function.name);
      }
    }
  }

  return byId;
}

function encodeToolResultMessage(message: NanoGptChatMessage, toolNameById: ReadonlyMap<string, string>): string {
  const toolName =
    (typeof message.tool_call_id === "string" && toolNameById.get(message.tool_call_id)) || "tool";
  const content = contentToText(message.content).trim();

  return [
    `[TOOL EXECUTION RESULT: ${toolName}]`,
    content,
    "",
    `[SYSTEM INSTRUCTION: The tool '${toolName}' already ran. Do not repeat or re-invoke it unless the new evidence clearly requires a new call. Analyze the result above and continue to the next logical step.]`,
  ].join("\n");
}

function encodeAssistantToolCallsMessage(message: NanoGptChatMessage): string {
  return JSON.stringify({
    v: 1,
    mode: "tool",
    message: contentToText(message.content).trim(),
    tool_calls: (message.tool_calls ?? []).map((toolCall) => {
      const parsedArgs = tryParseJson(toolCall.function.arguments);
      const args =
        parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)
          ? parsedArgs
          : {};
      return {
        name: toolCall.function.name,
        arguments: args,
      };
    }),
  });
}

function collectSystemText(messages: readonly NanoGptChatMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => contentToText(message.content).trim())
    .filter(Boolean)
    .join("\n\n");
}

function unwrapJsonCodeFence(text: string): string | undefined {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return match?.[1]?.trim();
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizeEscapedXmlText(text: string): string {
  return text.replace(/\\"/g, '"').replace(/\\'/g, "'");
}

function parseXmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const normalizedSource = normalizeEscapedXmlText(source);

  for (const match of normalizedSource.matchAll(/([A-Za-z_][A-Za-z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? "");
  }

  return attributes;
}

function normalizeXmlParameterValue(
  attributes: Readonly<Record<string, string>>,
  value: string,
): unknown {
  const decodedValue = decodeXmlEntities(value).trim();
  if (!decodedValue) {
    return "";
  }

  const typeHint = (attributes.type ?? "").trim().toLowerCase();
  const treatAsString = attributes.string === "true" || typeHint === "string";
  if (treatAsString) {
    return decodedValue;
  }

  const parsedJson = tryParseJson(decodedValue);
  if (parsedJson !== undefined) {
    return parsedJson;
  }

  const treatAsBoolean = attributes.boolean === "true" || typeHint === "boolean";
  if (treatAsBoolean) {
    if (/^true$/i.test(decodedValue)) {
      return true;
    }
    if (/^false$/i.test(decodedValue)) {
      return false;
    }
  }

  const treatAsNumber =
    attributes.number === "true" ||
    attributes.integer === "true" ||
    typeHint === "number" ||
    typeHint === "integer";
  if (treatAsNumber) {
    const parsedNumber = Number(decodedValue);
    if (Number.isFinite(parsedNumber)) {
      return parsedNumber;
    }
  }

  return decodedValue;
}

function extractXmlLikeToolCallPayload(text: string): BridgeTurnPayload | undefined {
  const normalizedText = normalizeEscapedXmlText(text);
  const match = normalizedText.match(/([\s\S]*?)<tool_calls>([\s\S]*?)<\/tool_calls>([\s\S]*)/i);
  if (!match) {
    return undefined;
  }

  const [, before, toolCallsBlock, after] = match;
  const toolCalls = Array.from(
    toolCallsBlock.matchAll(/<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/gi),
  ).flatMap((toolCallMatch) => {
    const attributes = parseXmlAttributes(toolCallMatch[1] ?? "");
    const name = attributes.name?.trim();
    if (!name) {
      return [];
    }

    const body = toolCallMatch[2] ?? "";
    const parameters: Record<string, unknown> = {};
    for (const parameterMatch of body.matchAll(/<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi)) {
      const parameterAttributes = parseXmlAttributes(parameterMatch[1] ?? "");
      const parameterName = parameterAttributes.name?.trim();
      if (!parameterName) {
        continue;
      }

      parameters[parameterName] = normalizeXmlParameterValue(
        parameterAttributes,
        parameterMatch[2] ?? "",
      );
    }

    const bodyWithoutParameters = body
      .replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi, "")
      .trim();

    return [{
      name,
      arguments:
        Object.keys(parameters).length > 0
          ? parameters
          : bodyWithoutParameters
            ? decodeXmlEntities(bodyWithoutParameters)
            : {},
    }];
  });

  if (toolCalls.length === 0) {
    return undefined;
  }

  const message = [before.trim(), after.trim()]
    .filter(Boolean)
    .map((part) => decodeXmlEntities(part))
    .join("\n\n")
    .trim();

  return {
    v: 1,
    mode: "tool",
    message,
    tool_calls: toolCalls,
  };
}

function extractTopLevelJsonValue(text: string): string | undefined {
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

function normalizeBridgeMode(mode: unknown, hasToolCalls: boolean): "tool" | "final" | "clarify" {
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

function contentValueToText(value: unknown): string {
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

function normalizeToolArguments(value: unknown): object {
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
    return cloneSchema(value);
  }

  if (Array.isArray(value)) {
    return { items: cloneSchema(value) };
  }

  return { value };
}

function canonicalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildKnownToolNameMap(tools: readonly VscodeLikeTool[]): Map<string, string> {
  const knownNames = new Map<string, string>();

  for (const tool of tools) {
    const canonical = canonicalizeToolName(tool.name);
    if (canonical && !knownNames.has(canonical)) {
      knownNames.set(canonical, tool.name);
    }
  }

  return knownNames;
}

function resolveToolName(name: unknown, knownNames: ReadonlyMap<string, string>): string | undefined {
  if (typeof name !== "string" || !name.trim()) {
    return undefined;
  }

  return knownNames.get(canonicalizeToolName(name)) ?? name.trim();
}

function normalizeToolCallsContainer(value: unknown): unknown[] {
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

function normalizeToolCall(
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

function normalizeBridgeTurnPayload(value: unknown, depth = 0): BridgeTurnPayload | undefined {
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

export function buildToolCallingBridgeMessages(params: {
  messages: readonly NanoGptChatMessage[];
  tools: readonly VscodeLikeTool[];
  toolMode?: "auto" | "required";
  parallelToolCalls?: boolean;
}): NanoGptChatMessage[] {
  const inheritedSystemText = collectSystemText(params.messages);
  const manifest = JSON.stringify(buildToolManifest(params.tools), null, 2);
  const toolNameById = buildToolCallNameMap(params.messages);
  const parallelAllowed = params.parallelToolCalls !== false;
  const toolCallsRequired = params.toolMode === "required";
  const exampleTool = params.tools[0];
  const exampleArguments = exampleTool?.inputSchema && typeof exampleTool.inputSchema === "object"
    ? Object.fromEntries(
        Object.keys(
          (exampleTool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
        ).map((key) => [key, "example"]),
      )
    : { input: "example" };

  const systemPrompt = [
    "# Structured Tool-Calling Contract",
    "",
    "Return exactly one JSON object and nothing else.",
    "Do not use markdown fences.",
    "Do not emit prose before or after the JSON object.",
    "",
    "Required field order:",
    '1. "v"',
    '2. "mode"',
    '3. "message"',
    '4. "tool_calls" (only when mode is "tool")',
    "",
    "Rules:",
    '- "v" must be 1.',
    '- "mode" must be "tool", "final", or "clarify".',
    '- "message" must always be a user-facing string.',
    '- When mode is "tool", "tool_calls" must be a non-empty array.',
    '- When mode is "final" or "clarify", do not include "tool_calls".',
    '- Prefer each tool call to use "name" and an "arguments" object.',
    '- If other instructions ask for commentary, progress updates, plans, or final answers, satisfy them inside the "message" field.',
    '- Never emit channel labels or plain prose outside the JSON object.',
    toolCallsRequired
      ? '- Tool calls are required for this turn. Choose the most relevant tool instead of returning final text.'
      : '- Use "clarify" when you genuinely need user input before any tool can run safely.',
    parallelAllowed
      ? '- You may emit multiple tool calls only when they are clearly independent.'
      : '- Emit exactly one tool call when mode is "tool".',
    "",
    "Examples:",
    JSON.stringify(
      {
        v: 1,
        mode: "tool",
        message: "I will inspect the relevant files now.",
        tool_calls: exampleTool
          ? [{ name: exampleTool.name, arguments: exampleArguments }]
          : [{ name: "read_file", arguments: { path: "README.md" } }],
      },
      null,
      2,
    ),
    JSON.stringify({ v: 1, mode: "clarify", message: "Which file should I update?" }, null, 2),
    JSON.stringify({ v: 1, mode: "final", message: "Done." }, null, 2),
    "",
    "Tool manifest:",
    manifest,
    inheritedSystemText
      ? "\nAdditional system instructions to preserve while obeying the JSON-only contract:\n" +
        inheritedSystemText
      : "",
  ].join("\n");

  return [
    {
      role: "system",
      content: systemPrompt,
    },
    ...params.messages.flatMap((message) => {
      if (message.role === "system") {
        return [];
      }

      if (message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0) {
        return [{ role: "assistant" as const, content: encodeAssistantToolCallsMessage(message) }];
      }

      if (message.role === "tool") {
        return [
          {
            role: "user" as const,
            content: encodeToolResultMessage(message, toolNameById),
          },
        ];
      }

      return [message];
    }),
  ];
}

export function buildToolCallingBridgeRepairMessages(params: {
  messages: readonly NanoGptChatMessage[];
  invalidResponse: string;
  toolMode?: "auto" | "required";
  repairReason: "invalid_response" | "required_tool_missing";
}): NanoGptChatMessage[] {
  const previousReply = params.invalidResponse.trim() || "(empty response)";
  const reasonInstruction =
    params.repairReason === "required_tool_missing"
      ? params.toolMode === "required"
        ? "Your previous reply still violated the contract because this turn requires at least one tool call."
        : "Your previous reply still violated the contract."
      : "Your previous reply violated the contract because it was not a single valid JSON object matching the schema above.";
  const requirementReminder =
    params.toolMode === "required"
      ? 'Return mode "tool" with a non-empty "tool_calls" array. Do not return "final" or "clarify" for this turn.'
      : 'If no tool call is needed, return mode "final" with the user-facing text in "message".';
  const repairInstruction = [
    "Your previous reply did not satisfy the structured tool-calling contract.",
    reasonInstruction,
    "Re-emit the same intent as exactly one JSON object that follows the system contract above.",
    "Output JSON only.",
    "Do not use markdown fences.",
    "Do not add commentary before or after the JSON object.",
    requirementReminder,
  ].join("\n");

  return [
    ...params.messages,
    { role: "assistant", content: previousReply },
    { role: "user", content: repairInstruction },
  ];
}

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
