import { describe, expect, test, vi } from "vitest";
import { NanoGptClient, type NanoGptLogger } from "../src/client.js";

describe("NanoGptClient", () => {
  const REQUIRED_TOOL_MODE_FAILURE_TEXT =
    "NanoGPT could not complete this required-tool turn safely. The model failed to return a valid structured tool call, so no tools were executed. Please retry or use a different model/provider.";

  function createLoggerSink(): { logger: NanoGptLogger; entries: string[] } {
    const entries: string[] = [];
    const createMethod = (level: string) => (message: string) => entries.push(`${level}:${message}`);

    return {
      logger: {
        trace: createMethod("trace"),
        debug: createMethod("debug"),
        info: createMethod("info"),
        warn: createMethod("warn"),
        error: createMethod("error"),
      },
      entries,
    };
  }

  function createReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index++]));
        } else {
          controller.close();
        }
      },
    });
  }

  test("streams text deltas from SSE", async () => {
    const fetchImpl = async () =>
      new Response(
        createReadableStream([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const texts: string[] = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }],
      routingMode: "subscription",
      onText: (t) => texts.push(t),
    });

    expect(texts).toEqual(["Hello", " world"]);
  });

  test("streams reasoning deltas from SSE", async () => {
    const fetchImpl = async () =>
      new Response(
        createReadableStream([
          'data: {"choices":[{"delta":{"reasoning":"Let me think"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"42"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const texts: string[] = [];
    const reasonings: string[] = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "2+2" }],
      routingMode: "subscription",
      onText: (t) => texts.push(t),
      onReasoning: (r) => reasonings.push(r),
    });

    expect(reasonings).toEqual(["Let me think"]);
    expect(texts).toEqual(["42"]);
  });

  test("streams tool calls from SSE chunks", async () => {
    const fetchImpl = async () =>
      new Response(
        createReadableStream([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const toolCalls: Array<{ callId: string; name: string; input: object }> = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Read a.txt" }],
      routingMode: "subscription",
      onText: () => {},
      onToolCall: (tc) => toolCalls.push(tc),
    });

    expect(toolCalls).toEqual([
      { type: "tool_call", callId: "call_1", name: "read_file", input: { path: "a.txt" } },
    ]);
  });

  test("flushes native tool calls at EOF when the stream ends without [DONE]", async () => {
    const fetchImpl = async () =>
      new Response(
        createReadableStream([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}\n\n',
        ]),
        { status: 200 },
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const toolCalls: Array<{ callId: string; name: string; input: object }> = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Read a.txt" }],
      routingMode: "subscription",
      onText: () => {},
      onToolCall: (toolCall) => toolCalls.push(toolCall),
    });

    expect(toolCalls).toEqual([
      { type: "tool_call", callId: "call_1", name: "read_file", input: { path: "a.txt" } },
    ]);
  });

  test("retries an empty native tool turn with bridge mode when strategy is auto", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"reasoning":"Thinking"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"{\\"v\\":1,\\"mode\\":\\"tool\\",\\"message\\":\\"I will inspect the file.\\",\\"tool_calls\\":[{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"README.md\\"}}]}"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const texts: string[] = [];
    const toolCalls: Array<{ callId: string; name: string; input: object }> = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Read the README" }],
      routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a workspace file" }],
      toolCallingStrategy: "auto",
      onText: (text) => texts.push(text),
      onToolCall: (toolCall) => toolCalls.push(toolCall),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(texts).toEqual(["I will inspect the file."]);
    expect(toolCalls).toEqual([
      {
        type: "tool_call",
        callId: "bridge_call_1",
        name: "read_file",
        input: { path: "README.md" },
      },
    ]);
  });

  test("retries a scaffolding native tool turn with bridge mode when strategy is auto", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"Let me start by reading the key project files and configuration."}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"{\\"v\\":1,\\"mode\\":\\"tool\\",\\"message\\":\\"I will inspect the file.\\",\\"tool_calls\\":[{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"README.md\\"}}]}"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const texts: string[] = [];
    const toolCalls: Array<{ callId: string; name: string; input: object }> = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Review the project" }],
      routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a workspace file" }],
      toolCallingStrategy: "auto",
      onText: (text) => texts.push(text),
      onToolCall: (toolCall) => toolCalls.push(toolCall),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(texts).toEqual(["I will inspect the file."]);
    expect(toolCalls).toEqual([
      {
        type: "tool_call",
        callId: "bridge_call_1",
        name: "read_file",
        input: { path: "README.md" },
      },
    ]);
  });

  test("retries the observed planning-text native tool turn with bridge mode when strategy is auto", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"Let me do a broad integrity scan of the codebase."}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"{\\"v\\":1,\\"mode\\":\\"tool\\",\\"message\\":\\"I will inspect the file.\\",\\"tool_calls\\":[{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"README.md\\"}}]}"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const texts: string[] = [];
    const toolCalls: Array<{ callId: string; name: string; input: object }> = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Review the project" }],
      routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a workspace file" }],
      toolCallingStrategy: "auto",
      onText: (text) => texts.push(text),
      onToolCall: (toolCall) => toolCalls.push(toolCall),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(texts).toEqual(["I will inspect the file."]);
    expect(toolCalls).toEqual([
      {
        type: "tool_call",
        callId: "bridge_call_1",
        name: "read_file",
        input: { path: "README.md" },
      },
    ]);
  });

  test("falls back to raw bridge text when the repair turn still omits JSON entirely", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"Let me start by reading the key project files and configuration."}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"I will inspect the relevant files and then summarize the findings."}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"I will inspect the relevant files and then summarize the findings."}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      );

    const { logger, entries } = createLoggerSink();
    const client = new NanoGptClient(fetchImpl as typeof fetch, logger);
    const texts: string[] = [];

    const result = await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Review the project" }],
      routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a workspace file" }],
      toolCallingStrategy: "auto",
      onText: (text) => texts.push(text),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(texts).toEqual([
      "Warning: NanoGPT bridge mode returned plain text instead of the required JSON tool-calling contract. Treating the raw reply below as a best-effort fallback.\n\nI will inspect the relevant files and then summarize the findings.",
    ]);
    expect(result.bridgeTelemetry).toEqual({
      bridgeRepairAttempts: 1,
      bridgeRepairSuccesses: 0,
      bridgeRawTextFallbacks: 1,
      bridgeRequiredFailClosed: 0,
    });
    expect(entries).toContain(
      "warn:[chat:bridge] tool-calling bridge response was non-compliant; retrying with a JSON-only repair turn",
    );
    expect(entries).toContain(
      "warn:[chat:bridge:repair] tool-calling bridge response omitted JSON; falling back to raw text",
    );
  });

  test("defaults omitted toolCallingStrategy to native", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"I\'ll start by reading the key source files and architecture docs to get a thorough understanding of the project before reviewing it."}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"{\\"v\\":1,\\"mode\\":\\"tool\\",\\"message\\":\\"I will inspect the file.\\",\\"tool_calls\\":[{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"README.md\\"}}]}"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const texts: string[] = [];
    const toolCalls: Array<{ callId: string; name: string; input: object }> = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Review the project" }],
      routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a workspace file" }],
      onText: (text) => texts.push(text),
      onToolCall: (toolCall) => toolCalls.push(toolCall),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(texts).toEqual([
      "I'll start by reading the key source files and architecture docs to get a thorough understanding of the project before reviewing it.",
    ]);
    expect(toolCalls).toEqual([]);
  });

  test("preserves substantive native text answers in auto mode", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(async () =>
      new Response(
        createReadableStream([
          'data: {"choices":[{"delta":{"content":"The README already documents the available commands."}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      ),
    );

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const texts: string[] = [];

    const result = await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "What commands are available?" }],
      routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a workspace file" }],
      toolCallingStrategy: "auto",
      onText: (text) => texts.push(text),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(texts).toEqual(["The README already documents the available commands."]);
    expect(result.bridgeTelemetry).toEqual({
      bridgeRepairAttempts: 0,
      bridgeRepairSuccesses: 0,
      bridgeRawTextFallbacks: 0,
      bridgeRequiredFailClosed: 0,
    });
    expect(result.requiredToolWarning).toBeUndefined();
  });

  test("returns structured telemetry for a native no-bridge text-only path", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(async () =>
      new Response(
        createReadableStream([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      ),
    );

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const texts: string[] = [];

    const result = await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Say hello" }],
      routingMode: "subscription",
      onText: (text) => texts.push(text),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(texts).toEqual(["Hello"]);
    expect(result.bridgeTelemetry).toEqual({
      bridgeRepairAttempts: 0,
      bridgeRepairSuccesses: 0,
      bridgeRawTextFallbacks: 0,
      bridgeRequiredFailClosed: 0,
    });
    expect(result.requiredToolWarning).toBeUndefined();
  });

  test("uses bridge mode directly when configured", async () => {
    const fetchCalls: Array<[string | URL | Request, RequestInit | undefined]> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      return new Response(
        createReadableStream([
          'data: {"choices":[{"delta":{"content":"{\\"v\\":1,\\"mode\\":\\"final\\",\\"message\\":\\"Done.\\"}"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      );
    };

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const texts: string[] = [];

    const result = await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Finish" }],
      routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a workspace file" }],
      toolCallingStrategy: "bridge",
      onText: (text) => texts.push(text),
    });

    expect(texts).toEqual(["Done."]);
    expect(result.bridgeTelemetry).toEqual({
      bridgeRepairAttempts: 0,
      bridgeRepairSuccesses: 0,
      bridgeRawTextFallbacks: 0,
      bridgeRequiredFailClosed: 0,
    });
    expect(result.requiredToolWarning).toBeUndefined();
    const bridgeRequest = JSON.parse(String(fetchCalls[0]?.[1]?.body ?? "{}")) as {
      tools?: unknown;
      messages?: Array<{ role?: string; content?: string }>;
    };
    expect(bridgeRequest.tools).toBeUndefined();
    expect(bridgeRequest.messages?.[0]?.role).toBe("system");
    expect(String(bridgeRequest.messages?.[0]?.content)).toContain("Structured Tool-Calling Contract");
  });

  test("carries required tool mode into the bridge prompt", async () => {
    const fetchCalls: Array<[string | URL | Request, RequestInit | undefined]> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      return new Response(
        createReadableStream([
          'data: {"choices":[{"delta":{"content":"{\\"v\\":1,\\"mode\\":\\"tool\\",\\"message\\":\\"I will inspect the file.\\",\\"tool_calls\\":[{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"README.md\\"}}]}"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      );
    };

    const client = new NanoGptClient(fetchImpl as typeof fetch);

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Read the README" }],
      routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a workspace file" }],
      toolCallingStrategy: "bridge",
      toolMode: "required",
      onText: () => {},
      onToolCall: () => {},
    });

    const bridgeRequest = JSON.parse(String(fetchCalls[0]?.[1]?.body ?? "{}")) as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    expect(String(bridgeRequest.messages?.[0]?.content)).toContain(
      "Tool calls are required for this turn.",
    );
  });

  test("repairs a prose-only bridge turn with a second JSON-only retry", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"I will inspect the relevant files and then summarize the findings."}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"{\\"v\\":1,\\"mode\\":\\"tool\\",\\"message\\":\\"I will inspect the file.\\",\\"tool_calls\\":[{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"README.md\\"}}]}"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      );

    const { logger, entries } = createLoggerSink();
    const client = new NanoGptClient(fetchImpl as typeof fetch, logger);
    const texts: string[] = [];
    const toolCalls: Array<{ callId: string; name: string; input: object }> = [];

    const result = await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Review the project" }],
      routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a workspace file" }],
      toolCallingStrategy: "bridge",
      onText: (text) => texts.push(text),
      onToolCall: (toolCall) => toolCalls.push(toolCall),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(texts).toEqual(["I will inspect the file."]);
    expect(toolCalls).toEqual([
      {
        type: "tool_call",
        callId: "bridge_call_1",
        name: "read_file",
        input: { path: "README.md" },
      },
    ]);
    expect(entries).toContain(
      "warn:[chat] tool-calling bridge response was non-compliant; retrying with a JSON-only repair turn",
    );
    expect(result.bridgeTelemetry).toEqual({
      bridgeRepairAttempts: 1,
      bridgeRepairSuccesses: 1,
      bridgeRawTextFallbacks: 0,
      bridgeRequiredFailClosed: 0,
    });
    expect(result.requiredToolWarning).toBeUndefined();
  });

  test("counts repaired bridge replies as successes when the repair turn yields a final answer", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"I will inspect the relevant files and then summarize the findings."}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"{\\"v\\":1,\\"mode\\":\\"final\\",\\"message\\":\\"Here is the summary.\\"}"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      );

    const { logger, entries } = createLoggerSink();
    const client = new NanoGptClient(fetchImpl as typeof fetch, logger);
    const texts: string[] = [];

    const result = await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Review the project" }],
      routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a workspace file" }],
      toolCallingStrategy: "bridge",
      onText: (text) => texts.push(text),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(texts).toEqual(["Here is the summary."]);
    expect(entries).toContain(
      "warn:[chat] tool-calling bridge response was non-compliant; retrying with a JSON-only repair turn",
    );
    expect(result.bridgeTelemetry).toEqual({
      bridgeRepairAttempts: 1,
      bridgeRepairSuccesses: 1,
      bridgeRawTextFallbacks: 0,
      bridgeRequiredFailClosed: 0,
    });
    expect(result.requiredToolWarning).toBeUndefined();
  });

  test("fails closed for required bridge turns when repair still returns no tool calls", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"I will inspect the relevant files and then summarize the findings."}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"{\\"v\\":1,\\"mode\\":\\"final\\",\\"message\\":\\"I can summarize the task without using any tools.\\"}"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      );

    const { logger, entries } = createLoggerSink();
    const client = new NanoGptClient(fetchImpl as typeof fetch, logger);
    const texts: string[] = [];
    const toolCalls: Array<{ callId: string; name: string; input: object }> = [];

    const result = await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Review the project" }],
      routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a workspace file" }],
      toolCallingStrategy: "bridge",
      toolMode: "required",
      onText: (text) => texts.push(text),
      onToolCall: (toolCall) => toolCalls.push(toolCall),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(texts).toEqual([]);
    expect(toolCalls).toEqual([]);
    expect(result.requiredToolWarning).toBe(REQUIRED_TOOL_MODE_FAILURE_TEXT);
    expect(result.bridgeTelemetry).toEqual({
      bridgeRepairAttempts: 1,
      bridgeRepairSuccesses: 1,
      bridgeRawTextFallbacks: 0,
      bridgeRequiredFailClosed: 1,
    });
    expect(entries).toContain(
      "warn:[chat] tool-calling bridge response was non-compliant; retrying with a JSON-only repair turn",
    );
    expect(entries).toContain(
      "warn:[chat] tool-calling bridge required a tool call but the model did not return one; failing closed",
    );
  });

  test("warns when model discovery returns an unexpected JSON shape", async () => {
    const { logger, entries } = createLoggerSink();
    const client = new NanoGptClient(
      (async () =>
        new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
      logger,
    );

    const models = await client.discoverModels({
      apiKey: "test-key",
      routingMode: "subscription",
      requestId: "discovery-shape",
    });

    expect(models).toEqual([]);
    expect(entries).toContain(
      "warn:[discovery-shape] model discovery payload had unexpected shape; treating it as empty",
    );
  });

  test("throws with NanoGPT JSON error body", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          error: { message: "Invalid API key", type: "auth_error", code: "401" },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch);

    await expect(
      client.streamChatCompletions({
        apiKey: "bad-key",
        modelId: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hi" }],
        routingMode: "subscription",
        onText: () => {},
      }),
    ).rejects.toThrow("[NanoGPT] Invalid API key (auth_error) [401]");
  });

  test("throws with generic message on non-JSON error body", async () => {
    const fetchImpl = async () =>
      new Response("Internal Server Error", { status: 500 });

    const client = new NanoGptClient(fetchImpl as typeof fetch);

    await expect(
      client.streamChatCompletions({
        apiKey: "test-key",
        modelId: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hi" }],
        routingMode: "subscription",
        onText: () => {},
      }),
    ).rejects.toThrow("NanoGPT chat request failed with HTTP 500");
  });

  test("respects AbortSignal cancellation", async () => {
    const controller = new AbortController();
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      // Abort immediately so the request never completes.
      controller.abort();
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return new Response(createReadableStream([]), { status: 200 });
    };

    const client = new NanoGptClient(fetchImpl as typeof fetch);

    await expect(
      client.streamChatCompletions({
        apiKey: "test-key",
        modelId: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hi" }],
        routingMode: "subscription",
        signal: controller.signal,
        onText: () => {},
      }),
    ).rejects.toThrow();
  });

  test("returns early when response body is missing", async () => {
    const fetchImpl = async () =>
      new Response(null, { status: 200 });

    const client = new NanoGptClient(fetchImpl as typeof fetch);

      await expect(
        client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }],
      routingMode: "subscription",
          onText: () => {},
        }),
      ).rejects.toThrow("NanoGPT stream returned no content after 3 attempts");
  });

  test("releases the response reader after streaming completes", async () => {
    let released = false;
    let cancelled = false;
    const reader = {
      async read() {
        return { done: true, value: undefined };
      },
      async cancel() {
        cancelled = true;
      },
      releaseLock() {
        released = true;
      },
    };

    const fetchImpl = async () =>
      ({
        ok: true,
        status: 200,
        body: {
          getReader() {
            return reader;
          },
        },
      }) as Response;

    const client = new NanoGptClient(fetchImpl as typeof fetch);

      await expect(
        client.streamChatCompletions({
          apiKey: "test-key",
          modelId: "gpt-5.4-mini",
          messages: [{ role: "user", content: "Hi" }],
          routingMode: "subscription",
          onText: () => {},
        }),
      ).rejects.toThrow("NanoGPT stream returned no content after 3 attempts");

      // Reader cleanup still happens via executeStreamingRequest's finally
      // block on every attempt, even after the error is thrown.
    expect(cancelled).toBe(true);
    expect(released).toBe(true);
  });

  test("emits sanitized lifecycle logs for chat requests", async () => {
    const { logger, entries } = createLoggerSink();
    const fetchImpl = async () =>
      new Response(
        createReadableStream([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch, logger);

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Secret prompt" }],
      routingMode: "subscription",
      requestId: "chat-42",
      onText: () => {},
    });

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("debug:[chat-42] HTTP POST /chat/completions"),
        expect.stringContaining("toolCallingStrategy=native"),
        expect.stringContaining("debug:[chat-42] chat response received (status=200"),
        expect.stringContaining("trace:[chat-42] chat stream processed (chunks="),
        expect.stringContaining("textParts=1, reasoningParts=0, toolCalls=0"),
      ]),
    );
    expect(entries.join("\n")).not.toContain("test-key");
    expect(entries.join("\n")).not.toContain("Secret prompt");
  });

  test("discovers models via subscription endpoint", async () => {
    const fetchCalls: Array<[string | URL | Request, RequestInit | undefined]> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "gpt-5.4-mini",
              name: "GPT-5.4 Mini",
              context_length: 200000,
              max_output_tokens: 32768,
              capabilities: { vision: true, tool_calling: false },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const models = await client.discoverModels({
      apiKey: "test-key",
      routingMode: "subscription",
    });

    expect(String(fetchCalls[0]?.[0])).toBe(
      "https://nano-gpt.com/api/subscription/v1/models?detailed=true",
    );
    expect(models[0]?.id).toBe("gpt-5.4-mini");
  });

  test("discovers models via paygo endpoint", async () => {
    const fetchCalls: Array<[string | URL | Request, RequestInit | undefined]> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      return new Response(
        JSON.stringify([
          {
            id: "moonshotai/kimi-k2.5",
            name: "Kimi K2.5",
            contextWindow: 262144,
            maxTokens: 8192,
            capabilities: { vision: true, tool_calling: true },
          },
        ]),
        { status: 200 },
      );
    };

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const models = await client.discoverModels({
      apiKey: "test-key",
      routingMode: "paygo",
    });

    expect(String(fetchCalls[0]?.[0])).toBe(
      "https://nano-gpt.com/api/v1/models?detailed=true",
    );
    expect(models[0]?.name).toBe("Kimi K2.5");
  });

  test("filters discovery with an allowlist", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "a", name: "A", context_length: 1000, capabilities: {} },
            { id: "b", name: "B", context_length: 1000, capabilities: {} },
            { id: "c", name: "C", context_length: 1000, capabilities: {} },
          ],
        }),
        { status: 200 },
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const models = await client.discoverModels({
      apiKey: "test-key",
      routingMode: "subscription",
      allowlist: ["a", "c"],
    });

    expect(models.map((m) => m.id)).toEqual(["a", "c"]);
  });

  // ── discoverModels edge cases ─────────────────────────────────────────────

  test("discovers models from a flat array response body", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify([
          { id: "flat-model", name: "Flat Model", context_length: 50000, capabilities: {} },
        ]),
        { status: 200 },
      );
    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const models = await client.discoverModels({ apiKey: "test-key", routingMode: "paygo" });
    expect(models[0]?.id).toBe("flat-model");
  });

  test("returns empty list when response payload has an unexpected shape", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ unexpected: "shape" }), { status: 200 });
    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const models = await client.discoverModels({ apiKey: "key", routingMode: "subscription" });
    expect(models).toEqual([]);
  });

  test("throws when model discovery returns a non-OK status", async () => {
    const fetchImpl = async () => new Response("Unauthorized", { status: 401 });
    const client = new NanoGptClient(fetchImpl as typeof fetch);
    await expect(
      client.discoverModels({ apiKey: "bad-key", routingMode: "subscription" }),
    ).rejects.toThrow("NanoGPT model discovery failed with HTTP 401");
  });

  test("emits sanitized lifecycle logs for model discovery", async () => {
    const { logger, entries } = createLoggerSink();
    const fetchImpl = async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 });
    const client = new NanoGptClient(fetchImpl as typeof fetch, logger);
    await client.discoverModels({
      apiKey: "super-secret-key",
      routingMode: "subscription",
      requestId: "disc-1",
    });
    const log = entries.join("\n");
    expect(log).toContain("[disc-1]");
    expect(log).not.toContain("super-secret-key");
  });

  // ── streamChatCompletions error body edge cases ───────────────────────────

  test("formats error message without type or code when those fields are absent", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ error: { message: "Rate limit exceeded" } }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    const client = new NanoGptClient(fetchImpl as typeof fetch);
    await expect(
      client.streamChatCompletions({
        apiKey: "test-key",
        modelId: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hi" }],
        routingMode: "subscription",
        onText: () => {},
      }),
    ).rejects.toThrow("[NanoGPT] Rate limit exceeded");
  });

  test("uses default HTTP error message when JSON error body lacks a message field", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: {} }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    const client = new NanoGptClient(fetchImpl as typeof fetch);
    await expect(
      client.streamChatCompletions({
        apiKey: "test-key",
        modelId: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hi" }],
        routingMode: "subscription",
        onText: () => {},
      }),
    ).rejects.toThrow("NanoGPT chat request failed with HTTP 429");
  });

  // ── AbortSignal edge cases ────────────────────────────────────────────────

  test("aborts immediately when the provided signal is already aborted before the call", async () => {
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));

    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return new Response(createReadableStream([]), { status: 200 });
    };

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    await expect(
      client.streamChatCompletions({
        apiKey: "test-key",
        modelId: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hi" }],
        routingMode: "subscription",
        signal: controller.signal,
        onText: () => {},
      }),
    ).rejects.toThrow();
  });

  test("passes through caller abort signal on model discovery", async () => {
    const controller = new AbortController();
    controller.abort();

    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    await expect(
      client.discoverModels({
        apiKey: "test-key",
        routingMode: "subscription",
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  // ── logging edge cases ────────────────────────────────────────────────────

  test("falls back to 'unknown' in logs when response has no content-type header", async () => {
    const { logger, entries } = createLoggerSink();
    const fetchImpl = async () =>
      new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        { status: 200 }, // no Content-Type header
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch, logger);
    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }],
      routingMode: "subscription",
      requestId: "hdr-test",
      onText: () => {},
    });

    // The debug log for "chat response received" should fall back to "unknown"
    // for content-type since no header was set.
    const responseLog = entries.find(
      (e) => e.includes("[hdr-test]") && e.includes("chat response received"),
    );
    expect(responseLog).toMatch(/contentType=unknown/);
  });

  test("processes SSE content remaining in the post-loop final buffer", async () => {
    // When the last chunk has no trailing newline, [DONE] stays in the residual
    // buffer after the main read loop and is flushed in the post-loop decoder step.
    // This covers the for-loop body in the final buffer parse (the toolCallCount branch).
    const fetchImpl = async () =>
      new Response(
        createReadableStream([
          // Tool call delta with a trailing newline — processed inside main loop
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"fin","type":"function","function":{"name":"final_fn","arguments":"{}"}}]}}]}\n',
          // [DONE] without trailing newline — stays in buffer for post-loop flush
          "data: [DONE]",
        ]),
        { status: 200 },
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const toolCalls: Array<{ callId: string; name: string }> = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Call fn" }],
      routingMode: "subscription",
      onText: () => {},
      onToolCall: (tc) => toolCalls.push(tc),
    });

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ callId: "fin", name: "final_fn" });
  });

  test("counts text parts emitted from the post-loop final buffer", async () => {
    const { logger, entries } = createLoggerSink();
    const fetchImpl = async () =>
      new Response(
        createReadableStream([
          // Text delta without trailing newline — ends up in final buffer
          'data: {"choices":[{"delta":{"content":"late"}}]}',
        ]),
        { status: 200 },
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch, logger);
    const texts: string[] = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }],
      routingMode: "subscription",
      requestId: "buf-text",
      onText: (t) => texts.push(t),
    });

    expect(texts).toEqual(["late"]);
    // The trace log should reflect the text part counted in the post-loop step.
    const traceLog = entries.find((e) => e.includes("[buf-text]") && e.includes("chat stream processed"));
    expect(traceLog).toMatch(/textParts=1/);
  });

  test("counts reasoning parts emitted from the post-loop final buffer", async () => {
    const { logger, entries } = createLoggerSink();
    const fetchImpl = async () =>
      new Response(
        createReadableStream([
          // Reasoning delta without trailing newline — ends up in final buffer
          'data: {"choices":[{"delta":{"reasoning":"deep thought"}}]}',
        ]),
        { status: 200 },
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch, logger);
    const reasonings: string[] = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Think" }],
      routingMode: "subscription",
      requestId: "buf-reasoning",
      onText: () => {},
      onReasoning: (r) => reasonings.push(r),
    });

    expect(reasonings).toEqual(["deep thought"]);
    const traceLog = entries.find((e) => e.includes("[buf-reasoning]") && e.includes("chat stream processed"));
    expect(traceLog).toMatch(/reasoningParts=1/);
  });

  test("aborts with TimeoutError when request exceeds the stream timeout", async () => {
    // Covers the setTimeout callback body in withTimeout (the line that fires
    // controller.abort with a TimeoutError DOMException).
    vi.useFakeTimers();
    try {
      const fetchImpl = (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation timed out.", "TimeoutError")),
          );
        });

      const clientPromise = new NanoGptClient(fetchImpl as typeof fetch).streamChatCompletions({
        apiKey: "test-key",
        modelId: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hi" }],
        routingMode: "subscription",
        onText: () => {},
      });

      // Attach the rejection handler BEFORE firing timers to avoid the
      // "PromiseRejectionHandledWarning" that arises when a rejection briefly
      // has no handler before we can assert on it.
      const assertion = expect(clientPromise).rejects.toThrow("The operation timed out.");

      // Fire all pending timers, including the 5-minute stream timeout.
      await vi.runAllTimersAsync();

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("logs counts for reasoning and tool call parts", async () => {
    const { logger, entries } = createLoggerSink();
    const fetchImpl = async () =>
      new Response(
        createReadableStream([
          'data: {"choices":[{"delta":{"reasoning":"thinking..."}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch, logger);
    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Think" }],
      routingMode: "subscription",
      requestId: "count-test",
      onText: () => {},
      onReasoning: () => {},
    });

    const traceLog = entries.find(
      (e) => e.includes("[count-test]") && e.includes("chat stream processed"),
    );
    expect(traceLog).toMatch(/textParts=1/);
    expect(traceLog).toMatch(/reasoningParts=1/);
  });

  test("suppresses scaffolding text before tool calls in native mode with tools", async () => {
    const fetchImpl = async () =>
      new Response(
        createReadableStream([
          'data: {"choices":[{"delta":{"content":"Let me gather related files and inspect the project structure."}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      );

    const { logger, entries } = createLoggerSink();
    const client = new NanoGptClient(fetchImpl as typeof fetch, logger);
    const texts: string[] = [];
    const toolCalls: Array<{ callId: string; name: string; input: object }> = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Review the project" }],
      routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a workspace file" }],
      toolCallingStrategy: "native",
      onText: (text) => texts.push(text),
      onToolCall: (toolCall) => toolCalls.push(toolCall),
    });

    expect(texts).toEqual([]);
    expect(toolCalls).toEqual([
      { type: "tool_call", callId: "call_1", name: "read_file", input: { path: "README.md" } },
    ]);
    expect(entries).toContainEqual(
      expect.stringContaining("info:[chat] suppressed scaffolding text before tool calls"),
    );
  });

  test("preserves substantive text alongside tool calls in native mode", async () => {
    const fetchImpl = async () =>
      new Response(
        createReadableStream([
          'data: {"choices":[{"delta":{"content":"The README already documents the available commands. Let me check the source code for any undocumented features."}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"src/index.ts\\"}"}}]}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const texts: string[] = [];
    const toolCalls: Array<{ callId: string; name: string; input: object }> = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Review the project" }],
      routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a workspace file" }],
      toolCallingStrategy: "native",
      onText: (text) => texts.push(text),
      onToolCall: (toolCall) => toolCalls.push(toolCall),
    });

    expect(texts).toEqual([
      "The README already documents the available commands. Let me check the source code for any undocumented features.",
    ]);
    expect(toolCalls).toEqual([
      { type: "tool_call", callId: "call_1", name: "read_file", input: { path: "src/index.ts" } },
    ]);
  });

  test("streams text normally when no tool calls arrive in native mode with tools", async () => {
    const fetchImpl = async () =>
      new Response(
        createReadableStream([
          'data: {"choices":[{"delta":{"content":"Here is the project overview."}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const texts: string[] = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Summarize the project" }],
      routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a workspace file" }],
      toolCallingStrategy: "native",
      onText: (text) => texts.push(text),
    });

    expect(texts).toEqual(["Here is the project overview."]);
  });

  test("retries on transient network error and succeeds on second attempt", async () => {
    const { logger, entries } = createLoggerSink();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        throw new Error("fetch failed: network error");
      })
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"Recovered"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch, logger);
    const texts: string[] = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }],
      routingMode: "subscription",
      onText: (t) => texts.push(t),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(texts).toEqual(["Recovered"]);
    const retryLog = entries.find((e) => e.includes("retrying in"));
    expect(retryLog).toBeDefined();
  });

  test("retries on 0-part response and succeeds on second attempt", async () => {
    const { logger } = createLoggerSink();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream(["data: [DONE]\n\n"]),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"Second try"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch, logger);
    const texts: string[] = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }],
      routingMode: "subscription",
      onText: (t) => texts.push(t),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(texts).toEqual(["Second try"]);
  });

  test("does not retry on non-retryable HTTP errors like 401", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({ error: { message: "Invalid API key", type: "auth_error", code: "invalid_key" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = new NanoGptClient(fetchImpl as typeof fetch);

    await expect(
      client.streamChatCompletions({
        apiKey: "bad-key",
        modelId: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hi" }],
        routingMode: "subscription",
        onText: () => {},
      }),
    ).rejects.toThrow(/Invalid API key/);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("does not retry when signal is already aborted", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      throw new Error("fetch failed: network error");
    });

    const controller = new AbortController();
    controller.abort();

    const client = new NanoGptClient(fetchImpl as typeof fetch);

    await expect(
      client.streamChatCompletions({
        apiKey: "test-key",
        modelId: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hi" }],
        routingMode: "subscription",
        signal: controller.signal,
        onText: () => {},
      }),
    ).rejects.toThrow();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("exhausts retries and throws after max attempts on persistent failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      throw new Error("fetch failed: network error");
    });

    const client = new NanoGptClient(fetchImpl as typeof fetch);

    await expect(
      client.streamChatCompletions({
        apiKey: "test-key",
        modelId: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hi" }],
        routingMode: "subscription",
        onText: () => {},
      }),
    ).rejects.toThrow(/fetch failed/);

    // 1 initial + 2 retries = 3 total
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("returns finishReason in summary for normal stop", async () => {
    const { logger } = createLoggerSink();
    const fetchImpl = async () =>
      new Response(
        createReadableStream([
          'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch, logger);
    const result = await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }],
      routingMode: "subscription",
      onText: () => {},
    });

    expect(result.summary.finishReason).toBe("stop");
  });

  test("warns on abnormal finish_reason 'length' in summary", async () => {
    const { logger, entries } = createLoggerSink();
    const fetchImpl = async () =>
      new Response(
        createReadableStream([
          'data: {"choices":[{"delta":{"content":"partial text"},"finish_reason":"length"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch, logger);
    const result = await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Long story" }],
      routingMode: "subscription",
      requestId: "finish-length",
      onText: () => {},
    });

    expect(result.summary.finishReason).toBe("length");
    const warnLog = entries.find((e) => e.includes("finish-length") && e.includes("abnormal finish_reason"));
    expect(warnLog).toBeDefined();
  });
});
