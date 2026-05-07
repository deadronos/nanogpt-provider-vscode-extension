import { describe, expect, test } from "vitest";
import { NanoGptSseParser, collectSseResponseParts, collectSseTextDeltas } from "../src/nanogpt-parser.js";

describe("nanogpt-parser: SSE parser", () => {
  test("extracts streamed text deltas from OpenAI-compatible SSE chunks", () => {
    const text = collectSseTextDeltas([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      "data: [DONE]",
    ]);
    expect(text).toEqual(["Hel", "lo"]);
  });

  test("extracts streamed tool-call deltas from OpenAI-compatible SSE chunks", () => {
    const parts = collectSseResponseParts([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}',
      "data: [DONE]",
    ]);
    expect(parts).toEqual([{ type: "tool_call", callId: "call_1", name: "read_file", input: { path: "README.md" } }]);
  });

  test("extracts multiple indexed tool calls streamed in separate chunks", () => {
    const parts = collectSseResponseParts([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"b.txt\\"}"}}]}}]}',
      "data: [DONE]",
    ]);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "tool_call", callId: "call_1", name: "read_file", input: { path: "a.txt" } });
    expect(parts[1]).toEqual({ type: "tool_call", callId: "call_2", name: "write_file", input: { path: "b.txt" } });
  });

  test("extracts streamed reasoning deltas from common OpenAI-compatible fields", () => {
    const parts = collectSseResponseParts([
      'data: {"choices":[{"delta":{"reasoning":"First "}}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"inspect."}}]}',
      'data: {"choices":[{"delta":{"thinking":" Then answer."}}]}',
    ]);
    expect(parts).toEqual([
      { type: "reasoning", text: "First " },
      { type: "reasoning", text: "inspect." },
      { type: "reasoning", text: " Then answer." },
    ]);
  });

  test("skips SSE lines that do not start with 'data:'", () => {
    const parts = collectSseResponseParts([
      "event: message", "id: 123", ": heartbeat",
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
    ]);
    expect(parts).toEqual([{ type: "text", text: "hi" }]);
  });

  test("skips SSE data lines with empty payload", () => {
    const parts = collectSseResponseParts([
      "data: ",
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
    ]);
    expect(parts).toEqual([{ type: "text", text: "ok" }]);
  });

  test("skips malformed JSON SSE lines", () => {
    const parts = collectSseResponseParts([
      "data: {not valid json}",
      'data: {"choices":[{"delta":{"content":"good"}}]}',
    ]);
    expect(parts).toEqual([{ type: "text", text: "good" }]);
  });

  test("flushes tool calls on finish_reason tool_calls without [DONE]", () => {
    const parts = collectSseResponseParts([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"run","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
    ]);
    expect(parts).toEqual([{ type: "tool_call", callId: "call_1", name: "run", input: {} }]);
  });

  test("tool calls are emitted only once even if [DONE] arrives after finish_reason", () => {
    const parser = new NanoGptSseParser();
    const first = parser.acceptLines([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"run","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
    ]);
    const second = parser.acceptLines(["data: [DONE]"]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  test("falls back to empty object when tool call arguments are invalid JSON", () => {
    const parts = collectSseResponseParts([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"run","arguments":"not-valid-json"}}]}}]}',
      "data: [DONE]",
    ]);
    expect(parts).toEqual([{ type: "tool_call", callId: "call_1", name: "run", input: {} }]);
  });

  test("falls back to empty object when tool call arguments parse to an array", () => {
    const parts = collectSseResponseParts([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"run","arguments":"[1,2,3]"}}]}}]}',
      "data: [DONE]",
    ]);
    expect(parts).toEqual([{ type: "tool_call", callId: "call_1", name: "run", input: {} }]);
  });

  test("falls back to empty object when tool call arguments parse to a non-object", () => {
    const parts = collectSseResponseParts([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"run","arguments":"42"}}]}}]}',
      "data: [DONE]",
    ]);
    expect(parts).toEqual([{ type: "tool_call", callId: "call_1", name: "run", input: {} }]);
  });

  test("skips tool calls missing id or name during flush", () => {
    const parts = collectSseResponseParts([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}',
      "data: [DONE]",
    ]);
    expect(parts).toHaveLength(0);
  });

  test("accumulates multi-chunk tool call deltas before flushing", () => {
    const parts = collectSseResponseParts([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":""}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":\\"test\\"}"}}]}}]}',
      "data: [DONE]",
    ]);
    expect(parts).toEqual([{ type: "tool_call", callId: "call_1", name: "search", input: { q: "test" } }]);
  });

  test("uses the latest streamed tool name chunk instead of concatenating fragments", () => {
    const parts = collectSseResponseParts([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"sea","arguments":""}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"search","arguments":"{\\"q\\":\\"test\\"}"}}]}}]}',
      "data: [DONE]",
    ]);
    expect(parts).toEqual([{ type: "tool_call", callId: "call_1", name: "search", input: { q: "test" } }]);
  });
});
