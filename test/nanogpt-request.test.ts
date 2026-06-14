import { describe, expect, test } from "vitest";
import { buildNanoGptChatCompletionRequest, prepareChatRequest } from "../src/nanogpt-request.js";
import type { NanoGptChatMessage } from "../src/nanogpt-types.js";

describe("nanogpt-request: buildNanoGptChatCompletionRequest", () => {
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
      Accept: "text/event-stream",
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

  test("builds chat completion requests with VS Code tools and required tool mode", () => {
    const request = buildNanoGptChatCompletionRequest({
      apiKey: "test-key",
      modelId: "moonshotai/kimi-k2.5",
      messages: [{ role: "user", content: "Read the file" }],
      routingMode: "paygo",
      tools: [{
        name: "read_file",
        description: "Read a workspace file",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }],
      toolMode: "required",
    });
    expect(JSON.parse(request.body)).toMatchObject({
      tools: [{ type: "function", function: { name: "read_file", description: "Read a workspace file" } }],
      tool_choice: "required",
    });
  });

  test("builds chat completion requests with reasoning controls", () => {
    const request = buildNanoGptChatCompletionRequest({
      apiKey: "test-key",
      modelId: "moonshotai/kimi-k2.5:thinking",
      messages: [{ role: "user", content: "Think carefully" }],
      routingMode: "paygo",
      reasoningEffort: "high",
      reasoningOutput: "native",
    });
    expect(JSON.parse(request.body)).toMatchObject({
      reasoning_effort: "high",
      reasoning: { exclude: false },
    });
  });

  test("omits reasoning field when reasoning output is hidden", () => {
    const request = buildNanoGptChatCompletionRequest({
      apiKey: "test-key",
      modelId: "moonshotai/kimi-k2.5:thinking",
      messages: [{ role: "user", content: "Think privately" }],
      routingMode: "paygo",
      reasoningEffort: "medium",
      reasoningOutput: "hidden",
    });
    expect(JSON.parse(request.body)).toMatchObject({
      reasoning_effort: "medium",
    });
    expect(JSON.parse(request.body)).not.toHaveProperty("reasoning");
  });

  test("X-Provider header appears only for paygo mode with a non-empty provider", () => {
    const withProvider = buildNanoGptChatCompletionRequest({
      apiKey: "test-key", modelId: "moonshotai/kimi-k2.5",
      messages: [{ role: "user", content: "Hi" }], routingMode: "paygo", provider: "openrouter",
    });
    expect(withProvider.headers["X-Provider"]).toBe("openrouter");

    const emptyProvider = buildNanoGptChatCompletionRequest({
      apiKey: "test-key", modelId: "moonshotai/kimi-k2.5",
      messages: [{ role: "user", content: "Hi" }], routingMode: "paygo", provider: "",
    });
    expect(emptyProvider.headers["X-Provider"]).toBeUndefined();

    const subscription = buildNanoGptChatCompletionRequest({
      apiKey: "test-key", modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }], routingMode: "subscription", provider: "openrouter",
    });
    expect(subscription.headers["X-Provider"]).toBeUndefined();
  });

  test("serializes all reasoning effort values: none, minimal, and xhigh", () => {
    for (const effort of ["none", "minimal", "xhigh"] as const) {
      const request = buildNanoGptChatCompletionRequest({
        apiKey: "test-key",
        modelId: "moonshotai/kimi-k2.5:thinking",
        messages: [{ role: "user", content: "Think" }],
        routingMode: "paygo",
        reasoningEffort: effort,
      });
      expect(JSON.parse(request.body)).toMatchObject({ reasoning_effort: effort });
    }
  });

  test("omits tools field when tools array is empty", () => {
    const request = buildNanoGptChatCompletionRequest({
      apiKey: "test-key", modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }], routingMode: "subscription", tools: [],
    });
    expect(JSON.parse(request.body)).not.toHaveProperty("tools");
  });

  test("omits max_tokens field when not provided", () => {
    const request = buildNanoGptChatCompletionRequest({
      apiKey: "test-key", modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }], routingMode: "subscription",
    });
    expect(JSON.parse(request.body)).not.toHaveProperty("max_tokens");
  });

  test("includes max_tokens when provided", () => {
    const request = buildNanoGptChatCompletionRequest({
      apiKey: "test-key", modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }], routingMode: "subscription", maxTokens: 512,
    });
    expect(JSON.parse(request.body)).toMatchObject({ max_tokens: 512 });
  });

  test("includes parallel_tool_calls when parallelToolCalls is true", () => {
    const request = buildNanoGptChatCompletionRequest({
      apiKey: "test-key", modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }], routingMode: "subscription", parallelToolCalls: true,
    });
    expect(JSON.parse(request.body)).toMatchObject({ parallel_tool_calls: true });
  });

  test("omits tool_choice when toolMode is auto", () => {
    const request = buildNanoGptChatCompletionRequest({
      apiKey: "test-key", modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }], routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a file" }], toolMode: "auto",
    });
    expect(JSON.parse(request.body)).not.toHaveProperty("tool_choice");
  });

  test("omits reasoning_effort field when not provided", () => {
    const request = buildNanoGptChatCompletionRequest({
      apiKey: "test-key", modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }], routingMode: "subscription",
    });
    expect(JSON.parse(request.body)).not.toHaveProperty("reasoning_effort");
  });

  test("rejects tool payloads exceeding the 200 KB NanoGPT limit", () => {
    const hugeTool = {
      name: "mega_tool",
      description: "A".repeat(250 * 1024),
      inputSchema: { type: "object", properties: { data: { type: "string" } } },
    };
    expect(() =>
      buildNanoGptChatCompletionRequest({
        apiKey: "test-key", modelId: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hi" }], routingMode: "subscription",
        tools: [hugeTool],
      }),
    ).toThrow("exceeds the 200 KB limit");
  });
});

describe("nanogpt-request: prepareChatRequest", () => {
  test("passes through normal messages unchanged", () => {
    const messages: NanoGptChatMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const result = prepareChatRequest(messages);
    expect(result).toEqual(messages);
  });

  test("drops empty assistant turns", () => {
    const messages: NanoGptChatMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "" },
      { role: "user", content: "Follow up" },
    ];
    const result = prepareChatRequest(messages);
    expect(result).toHaveLength(2);
    expect(result[0]!.content).toBe("Hello");
    expect(result[1]!.content).toBe("Follow up");
  });

  test("preserves assistant turns with non-empty content", () => {
    const messages: NanoGptChatMessage[] = [
      { role: "assistant", content: "I have content" },
      { role: "user", content: "OK" },
    ];
    const result = prepareChatRequest(messages);
    expect(result).toHaveLength(2);
  });

  test("strips oversized base64 inline images exceeding the size limit", () => {
    const smallBase64 = "data:image/png;base64," + "A".repeat(100);
    const oversizedBase64 = "data:image/png;base64," + "A".repeat(15_000_000);
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "Look at this" },
          { type: "image_url" as const, image_url: { url: smallBase64 } },
          { type: "image_url" as const, image_url: { url: oversizedBase64 } },
        ] as NanoGptChatMessage["content"],
      },
    ];
    const result = prepareChatRequest(messages as unknown as NanoGptChatMessage[]);
    const parts = result[0]!.content as Array<{ type: string; image_url?: { url: string } }>;
    const imageParts = parts.filter((p) => p.type === "image_url");
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]!.image_url!.url).toBe(smallBase64);
  });

  test("keeps non-data: image URLs intact", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "See image" },
          { type: "image_url" as const, image_url: { url: "https://example.com/image.png" } },
        ] as NanoGptChatMessage["content"],
      },
    ];
    const result = prepareChatRequest(messages as unknown as NanoGptChatMessage[]);
    const parts = result[0]!.content as Array<{ type: string }>;
    expect(parts).toHaveLength(2);
  });

  test("handles messages with non-array content", () => {
    const messages: NanoGptChatMessage[] = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hi" },
    ];
    const result = prepareChatRequest(messages);
    expect(result).toEqual(messages);
  });

  test("preserves all messages when nothing needs filtering", () => {
    const messages: NanoGptChatMessage[] = [
      { role: "system", content: "Be helpful" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "What time is it?" },
    ];
    const result = prepareChatRequest(messages);
    expect(result).toHaveLength(4);
    expect(result).toEqual(messages);
  });
});
