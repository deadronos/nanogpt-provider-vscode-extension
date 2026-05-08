import { describe, expect, test } from "vitest";
import {
  buildToolCallingBridgeMessages,
  parseToolCallingBridgeResponse,
} from "../src/nanogpt-tool-bridge.js";

describe("nanogpt-tool-bridge", () => {
  test("rewrites tool history into bridge-friendly messages", () => {
    const messages = buildToolCallingBridgeMessages({
      tools: [
        {
          name: "read_file",
          description: "Read a workspace file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      messages: [
        { role: "system", content: "Keep replies short." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"README.md"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "README contents" },
        { role: "user", content: "Now summarize it." },
      ],
      parallelToolCalls: false,
    });

    expect(messages[0]).toMatchObject({ role: "system" });
    expect(String(messages[0]?.content)).toContain('"mode"');
    expect(String(messages[0]?.content)).toContain("Keep replies short.");
    expect(String(messages[0]?.content)).toContain("Emit exactly one tool call");

    expect(messages[1]).toEqual({
      role: "assistant",
      content:
        '{"v":1,"mode":"tool","message":"","tool_calls":[{"name":"read_file","arguments":{"path":"README.md"}}]}',
    });

    expect(messages[2]).toMatchObject({ role: "user" });
    expect(String(messages[2]?.content)).toContain("[TOOL EXECUTION RESULT: read_file]");
    expect(String(messages[2]?.content)).toContain("Do not repeat or re-invoke it");
    expect(messages[3]).toEqual({ role: "user", content: "Now summarize it." });
  });

  test("parses a direct bridge final response", () => {
    const parsed = parseToolCallingBridgeResponse(
      '{"v":1,"mode":"final","message":"Done."}',
      [],
    );

    expect(parsed).toEqual({ kind: "final", content: "Done." });
  });

  test("parses nested bridge tool calls and normalizes known tool names", () => {
    const parsed = parseToolCallingBridgeResponse(
      JSON.stringify({
        response: {
          mode: "tool",
          message: "I will inspect the file.",
          tool_calls: [
            {
              name: "read-file",
              arguments: { path: "README.md" },
            },
          ],
        },
      }),
      [{ name: "read_file", description: "Read a file" }],
    );

    expect(parsed).toEqual({
      kind: "tool_calls",
      content: "I will inspect the file.",
      toolCalls: [{ name: "read_file", input: { path: "README.md" } }],
    });
  });

  test("extracts bridge JSON from fenced responses", () => {
    const parsed = parseToolCallingBridgeResponse(
      '```json\n{"v":1,"mode":"clarify","message":"Which path should I read?"}\n```',
      [],
    );

    expect(parsed).toEqual({ kind: "final", content: "Which path should I read?" });
  });

  test("accepts flattened tool arguments when the model omits an arguments object", () => {
    const parsed = parseToolCallingBridgeResponse(
      '{"v":1,"mode":"tool","message":"I will read the file.","tool_calls":[{"name":"read_file","path":"README.md"}]}',
      [{ name: "read_file", description: "Read a file" }],
    );

    expect(parsed).toEqual({
      kind: "tool_calls",
      content: "I will read the file.",
      toolCalls: [{ name: "read_file", input: { path: "README.md" } }],
    });
  });

  test("marks empty bridge turns invalid", () => {
    const parsed = parseToolCallingBridgeResponse('{"v":1,"mode":"tool","message":""}', []);

    expect(parsed).toMatchObject({
      kind: "invalid",
      errorCode: "invalid_schema_turn",
    });
  });
});
