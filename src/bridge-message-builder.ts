import {
  type NanoGptChatMessage,
  type NanoGptMessageContent,
  type VscodeLikeTool,
} from "./nanogpt-types.js";
import { deepClone, tryParseJson } from "./utils.js";

// ── Content helpers ─────────────────────────────────────────────────────────

function contentToText(content: NanoGptMessageContent): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function collectSystemText(messages: readonly NanoGptChatMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => contentToText(message.content).trim())
    .filter(Boolean)
    .join("\n\n");
}

// ── Tool manifest and name map ──────────────────────────────────────────────

function buildToolManifest(tools: readonly VscodeLikeTool[]): Array<{
  name: string;
  description: string;
  parameters: object;
  required: string[];
}> {
  return tools.map((tool) => {
    const schema = tool.inputSchema && typeof tool.inputSchema === "object"
      ? deepClone(tool.inputSchema)
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

// ── Message encoding helpers ────────────────────────────────────────────────

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

// ── Public API ──────────────────────────────────────────────────────────────

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
