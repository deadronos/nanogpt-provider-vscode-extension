import { describe, expect, test } from "vitest";
import { NanoGptClient } from "../src/client.js";

describe("NanoGptClient", () => {
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
    const texts: string[] = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }],
      routingMode: "subscription",
      onText: (t) => texts.push(t),
    });

    expect(texts).toEqual([]);
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
});
