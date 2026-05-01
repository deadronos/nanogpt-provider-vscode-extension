import { describe, expect, test } from "vitest";
import { NanoGptClient } from "../src/client.js";
import {
  buildNanoGptChatCompletionRequest,
  collectSseTextDeltas,
  estimateTokenCount,
  mapNanoGptModelsToVscode,
  toNanoGptMessages,
} from "../src/nanogpt.js";

describe("NanoGPT VS Code provider core", () => {
  test("maps VS Code chat messages to OpenAI-compatible NanoGPT messages", () => {
    const messages = toNanoGptMessages([
      {
        role: "user",
        content: [{ kind: "text", value: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ kind: "text", value: "Hi" }],
      },
      {
        role: "system",
        content: [{ kind: "text", value: "Keep replies short" }],
      },
    ]);

    expect(messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "system", content: "Keep replies short" },
    ]);
  });

  test("maps image data parts to OpenAI-compatible multimodal content", () => {
    const messages = toNanoGptMessages([
      {
        role: "user",
        content: [
          { kind: "text", value: "What is in this screenshot?" },
          {
            kind: "data",
            data: new Uint8Array([137, 80, 78, 71]),
            mimeType: "image/png",
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this screenshot?" },
          {
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,iVBORw==",
            },
          },
        ],
      },
    ]);
  });

  test("builds subscription chat completion requests without paygo provider header", () => {
    const request = buildNanoGptChatCompletionRequest({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }],
      routingMode: "subscription",
    });

    expect(request.url).toBe("https://nano-gpt.com/api/subscription/v1/chat/completions");
    expect(request.headers).toEqual({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(request.body)).toMatchObject({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
  });

  test("builds paygo requests with optional upstream provider header", () => {
    const request = buildNanoGptChatCompletionRequest({
      apiKey: "test-key",
      modelId: "moonshotai/kimi-k2.5",
      messages: [{ role: "user", content: "Hi" }],
      routingMode: "paygo",
      provider: "openrouter",
    });

    expect(request.url).toBe("https://nano-gpt.com/api/v1/chat/completions");
    expect(request.headers["X-Provider"]).toBe("openrouter");
  });

  test("extracts streamed text deltas from OpenAI-compatible SSE chunks", () => {
    const text = collectSseTextDeltas([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      "data: [DONE]",
    ]);

    expect(text).toEqual(["Hel", "lo"]);
  });

  test("maps discovered NanoGPT models into VS Code model metadata", () => {
    const models = mapNanoGptModelsToVscode([
      {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        context_length: 200000,
        max_output_tokens: 32768,
        capabilities: { vision: true, tool_calling: true },
      },
    ]);

    expect(models).toEqual([
      {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        family: "nanogpt",
        version: "nano-gpt",
        maxInputTokens: 167232,
        maxOutputTokens: 32768,
        detail: "NanoGPT",
        tooltip: "NanoGPT model gpt-5.4-mini",
        capabilities: {
          imageInput: true,
          toolCalling: true,
        },
      },
    ]);
  });

  test("estimates token counts consistently for text and message payloads", () => {
    expect(estimateTokenCount("12345678")).toBe(2);
    expect(
      estimateTokenCount({
        role: "user",
        content: [{ kind: "text", value: "1234" }, { kind: "text", value: "5678" }],
      }),
    ).toBe(2);
  });

  test("discovers models with detailed NanoGPT metadata", async () => {
    const fetchCalls: Array<[string | URL | Request, RequestInit | undefined]> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "moonshotai/kimi-k2.5:thinking",
              name: "Kimi K2.5 Thinking",
              context_length: 262144,
              max_output_tokens: 8192,
              capabilities: {
                vision: true,
                tool_calling: true,
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const models = await client.discoverModels({
      apiKey: "test-key",
      routingMode: "paygo",
    });

    expect(String(fetchCalls[0]?.[0])).toBe("https://nano-gpt.com/api/v1/models?detailed=true");
    expect(models[0]).toMatchObject({
      id: "moonshotai/kimi-k2.5:thinking",
      maxInputTokens: 253952,
      maxOutputTokens: 8192,
      capabilities: {
        imageInput: true,
        toolCalling: true,
      },
    });
  });
});
