import { describe, expect, test } from "vitest";
import { toNanoGptMessages } from "../src/nanogpt-message.js";

describe("nanogpt-message: toNanoGptMessages", () => {
  test("maps VS Code chat messages to OpenAI-compatible NanoGPT messages", () => {
    const messages = toNanoGptMessages([
      { role: "user", content: [{ kind: "text", value: "Hello" }] },
      { role: "assistant", content: [{ kind: "text", value: "Hi" }] },
      { role: "system", content: [{ kind: "text", value: "Keep replies short" }] },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "system", content: "Keep replies short" },
    ]);
  });

  test("maps numeric VS Code system roles to NanoGPT system messages", () => {
    const messages = toNanoGptMessages([
      { role: 0, content: [{ kind: "text", value: "Keep replies short" }] },
    ]);
    expect(messages).toEqual([{ role: "system", content: "Keep replies short" }]);
  });

  test("maps image data parts to OpenAI-compatible multimodal content", () => {
    const messages = toNanoGptMessages([
      {
        role: "user",
        content: [
          { kind: "text", value: "What is in this screenshot?" },
          { kind: "data", data: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" },
        ],
      },
    ]);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this screenshot?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } },
        ],
      },
    ]);
  });

  test("maps VS Code tool call and tool result parts to OpenAI-compatible history", () => {
    const messages = toNanoGptMessages([
      {
        role: "assistant",
        content: [{ callId: "call_1", name: "read_file", input: { path: "README.md" } }],
      },
      {
        role: "user",
        content: [{ callId: "call_1", content: [{ kind: "text", value: "file contents" }] }],
      },
    ]);
    expect(messages).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1", type: "function",
          function: { name: "read_file", arguments: '{"path":"README.md"}' },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
    ]);
  });

  test("preserves text content alongside tool results in the same message", () => {
    const messages = toNanoGptMessages([
      {
        role: "user",
        content: [
          { kind: "text", value: "Context: " },
          { callId: "call_1", content: [{ kind: "text", value: "file contents" }] },
        ],
      },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "Context: " },
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
    ]);
  });

  test("uses part.text when part.value is absent", () => {
    const messages = toNanoGptMessages([
      { role: "user", content: [{ text: "Hello via text property" }] },
    ]);
    expect(messages).toEqual([{ role: "user", content: "Hello via text property" }]);
  });

  test("ignores data parts with non-image mime types", () => {
    const messages = toNanoGptMessages([
      {
        role: "user",
        content: [
          { kind: "text", value: "hello" },
          { data: new Uint8Array([1, 2, 3]), mimeType: "application/pdf" },
        ],
      },
    ]);
    expect(messages).toEqual([{ role: "user", content: "hello" }]);
  });

  test("ignores parts that lack value, text, data, callId, and content", () => {
    const messages = toNanoGptMessages([
      {
        role: "assistant",
        content: [
          { name: "read_file" },
          { value: "fallback text" },
        ],
      },
    ]);
    expect(messages).toEqual([{ role: "assistant", content: "fallback text" }]);
  });

  test("handles non-object items inside a tool result content array", () => {
    const messages = toNanoGptMessages([
      {
        role: "user",
        content: [{ callId: "call_x", content: [null, "string-item", { value: "actual" }] }],
      },
    ]);
    expect(messages).toEqual([{ role: "tool", tool_call_id: "call_x", content: "actual" }]);
  });

  test("handles tool result content parts with no text or data", () => {
    const messages = toNanoGptMessages([
      {
        role: "user",
        content: [{ callId: "call_y", content: [{ kind: "unknown_type" }, { value: "real" }] }],
      },
    ]);
    expect(messages).toEqual([{ role: "tool", tool_call_id: "call_y", content: "real" }]);
  });

  test("decodes JSON binary data in tool result content", () => {
    const jsonBytes = new TextEncoder().encode('{"result":42}');
    const messages = toNanoGptMessages([
      {
        role: "user",
        content: [{ callId: "call_1", content: [{ data: jsonBytes, mimeType: "application/json" }] }],
      },
    ]);
    expect(messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: '{"result":42}' },
    ]);
  });

  test("decodes +json binary data in tool result content", () => {
    const jsonBytes = new TextEncoder().encode('{"x":1}');
    const messages = toNanoGptMessages([
      {
        role: "user",
        content: [{ callId: "call_json", content: [{ data: jsonBytes, mimeType: "application/ld+json" }] }],
      },
    ]);
    expect(messages).toEqual([
      { role: "tool", tool_call_id: "call_json", content: '{"x":1}' },
    ]);
  });

  test("decodes text/* binary data in tool result content", () => {
    const textBytes = new TextEncoder().encode("plain text result");
    const messages = toNanoGptMessages([
      {
        role: "user",
        content: [{ callId: "call_2", content: [{ data: textBytes, mimeType: "text/plain" }] }],
      },
    ]);
    expect(messages).toEqual([
      { role: "tool", tool_call_id: "call_2", content: "plain text result" },
    ]);
  });

  test("encodes unknown binary data in tool result content as a data URI", () => {
    const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const messages = toNanoGptMessages([
      {
        role: "user",
        content: [{ callId: "call_3", content: [{ data: binaryData, mimeType: "application/octet-stream" }] }],
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toMatch(/^data:application\/octet-stream;base64,/);
  });

  test("returns empty array for empty messages input", () => {
    expect(toNanoGptMessages([])).toEqual([]);
  });

  test("filters out messages containing only whitespace text", () => {
    const messages = toNanoGptMessages([
      { role: "user", content: [{ value: "   " }] },
      { role: "user", content: [{ value: "real message" }] },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("real message");
  });

  test("maps numeric role 1 to user and role 2 to assistant", () => {
    const messages = toNanoGptMessages([
      { role: 1, content: [{ value: "user msg" }] },
      { role: 2, content: [{ value: "assistant msg" }] },
    ]);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");
  });

  test("defaults unrecognised roles to user", () => {
    const messages = toNanoGptMessages([
      { role: 99, content: [{ value: "mystery numeric" }] },
      { role: "bot", content: [{ value: "unknown string" }] },
    ]);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("user");
  });
});
