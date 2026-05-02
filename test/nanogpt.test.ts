import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NanoGptClient } from "../src/client.js";
import {
  buildModelConfigurationSchema,
  buildNanoGptChatCompletionRequest,
  collectSseResponseParts,
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

  test("maps numeric VS Code system roles to NanoGPT system messages", () => {
    const messages = toNanoGptMessages([
      {
        role: 0,
        content: [{ kind: "text", value: "Keep replies short" }],
      },
    ]);

    expect(messages).toEqual([{ role: "system", content: "Keep replies short" }]);
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

  test("maps VS Code tool call and tool result parts to OpenAI-compatible history", () => {
    const messages = toNanoGptMessages([
      {
        role: "assistant",
        content: [
          {
            callId: "call_1",
            name: "read_file",
            input: { path: "README.md" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            callId: "call_1",
            content: [{ kind: "text", value: "file contents" }],
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "read_file",
              arguments: "{\"path\":\"README.md\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "file contents",
      },
    ]);
  });

  test("preserves text content alongside tool results in the same message", () => {
    const messages = toNanoGptMessages([
      {
        role: "user",
        content: [
          { kind: "text", value: "Context: " },
          {
            callId: "call_1",
            content: [{ kind: "text", value: "file contents" }],
          },
        ],
      },
    ]);

    // Text is preserved as a separate message before the tool result.
    expect(messages).toEqual([
      { role: "user", content: "Context: " },
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
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
      tools: [
        {
          name: "read_file",
          description: "Read a workspace file",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
        },
      ],
      toolMode: "required",
    });

    expect(JSON.parse(request.body)).toMatchObject({
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a workspace file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
          },
        },
      ],
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
      reasoning: {
        exclude: false,
      },
    });
  });

  test("can request reasoning exclusion when reasoning output is hidden", () => {
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
      reasoning: {
        exclude: true,
      },
    });
  });

  test("X-Provider header appears only for paygo mode with a non-empty provider", () => {
    const withProvider = buildNanoGptChatCompletionRequest({
      apiKey: "test-key",
      modelId: "moonshotai/kimi-k2.5",
      messages: [{ role: "user", content: "Hi" }],
      routingMode: "paygo",
      provider: "openrouter",
    });
    expect(withProvider.headers["X-Provider"]).toBe("openrouter");

    const emptyProvider = buildNanoGptChatCompletionRequest({
      apiKey: "test-key",
      modelId: "moonshotai/kimi-k2.5",
      messages: [{ role: "user", content: "Hi" }],
      routingMode: "paygo",
      provider: "",
    });
    expect(emptyProvider.headers["X-Provider"]).toBeUndefined();

    const subscription = buildNanoGptChatCompletionRequest({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Hi" }],
      routingMode: "subscription",
      provider: "openrouter",
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

    expect(parts).toEqual([
      {
        type: "tool_call",
        callId: "call_1",
        name: "read_file",
        input: { path: "README.md" },
      },
    ]);
  });

  test("extracts multiple indexed tool calls streamed in separate chunks", () => {
    const parts = collectSseResponseParts([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"b.txt\\"}"}}]}}]}',
      "data: [DONE]",
    ]);

    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      type: "tool_call",
      callId: "call_1",
      name: "read_file",
      input: { path: "a.txt" },
    });
    expect(parts[1]).toEqual({
      type: "tool_call",
      callId: "call_2",
      name: "write_file",
      input: { path: "b.txt" },
    });
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
    expect(collectSseTextDeltas(parts.map((part) => `data: ${JSON.stringify({ choices: [{ delta: part.type === "reasoning" ? { reasoning: (part as { type: "reasoning"; text: string }).text } : { content: (part as { type: "text"; text: string }).text } }] }) }`))).toEqual([]);
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
        reasoning: false,
        internal: {
          parallelToolCalls: false,
        },
        configurationSchema: expect.objectContaining({
          properties: expect.objectContaining({
            apiKey: expect.objectContaining({ secret: true }),
            routingMode: expect.objectContaining({ enum: ["subscription", "paygo"] }),
          }),
        }),
      },
    ]);
  });

  test("maps all NanoGPT capability fields correctly, leaving internal-only fields off VS Code surface", () => {
    // structured_output and pdf_upload are not in the capabilities type —
    // they are intentionally omitted from VS Code-visible mapping. We use a
    // type assertion to simulate what a NanoGPT response with those fields
    // would contain, then verify they do not leak into VS Code metadata.
    const rawEntry = {
      id: "test/model",
      name: "Test Model",
      context_length: 128000,
      max_output_tokens: 8192,
      capabilities: {
        vision: true,
        reasoning: true,
        tool_calling: true,
        parallel_tool_calls: true,
        structured_output: true,
        pdf_upload: true,
      },
    } as unknown as Parameters<typeof mapNanoGptModelsToVscode>[0][number];

    const models = mapNanoGptModelsToVscode([rawEntry]);

    expect(models).toHaveLength(1);
    expect(models[0]!.capabilities).toEqual({
      imageInput: true,
      toolCalling: true,
    });
    expect(models[0]!.reasoning).toBe(true);
    expect(models[0]!.internal).toEqual({
      parallelToolCalls: true,
    });
    // structured_output and pdf_upload must not appear in VS Code-visible capabilities.
    expect(models[0]!.capabilities).not.toHaveProperty("structuredOutput");
    expect(models[0]!.capabilities).not.toHaveProperty("pdfUpload");
  });

  test("advertises VS Code tool calling when NanoGPT reports tool-call support", () => {
    const models = mapNanoGptModelsToVscode([
      {
        id: "moonshotai/kimi-k2.5:thinking",
        name: "Kimi K2.5 Thinking",
        context_length: 262144,
        max_output_tokens: 8192,
        capabilities: { vision: true, tool_calling: true },
        reasoning: true,
      },
    ]);

    expect(models[0]?.capabilities).toEqual({
      imageInput: true,
      toolCalling: true,
    });
    expect(models[0]?.reasoning).toBe(true);
    expect(models[0]?.configurationSchema).toMatchObject({
      properties: {
        reasoningEffort: {
          enum: ["auto", "none", "minimal", "low", "medium", "high", "xhigh"],
        },
      },
    });
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
                reasoning: true,
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new NanoGptClient(fetchImpl as typeof fetch);

    // Paygo mode
    const paygoModels = await client.discoverModels({
      apiKey: "test-key",
      routingMode: "paygo",
    });
    expect(String(fetchCalls[fetchCalls.length - 1]?.[0])).toBe(
      "https://nano-gpt.com/api/v1/models?detailed=true",
    );
    expect(paygoModels[0]).toMatchObject({
      id: "moonshotai/kimi-k2.5:thinking",
      maxInputTokens: 253952,
      maxOutputTokens: 8192,
      capabilities: { imageInput: true, toolCalling: true },
      reasoning: true,
    });

    // Subscription mode
    const subModels = await client.discoverModels({
      apiKey: "test-key",
      routingMode: "subscription",
    });
    expect(String(fetchCalls[fetchCalls.length - 1]?.[0])).toBe(
      "https://nano-gpt.com/api/subscription/v1/models?detailed=true",
    );
    expect(subModels[0]?.id).toBe("moonshotai/kimi-k2.5:thinking");
  });

  test("rejects tool payloads exceeding the 200 KB NanoGPT limit", () => {
    const hugeTool = {
      name: "mega_tool",
      description: "A".repeat(250 * 1024),
      inputSchema: { type: "object", properties: { data: { type: "string" } } },
    };

    expect(() =>
      buildNanoGptChatCompletionRequest({
        apiKey: "test-key",
        modelId: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Hi" }],
        routingMode: "subscription",
        tools: [hugeTool],
      }),
    ).toThrow("exceeds the 200 KB limit");
  });

  test("buildModelConfigurationSchema properties match package.json languageModelChatProviders contribution", () => {
    // Guards against manual drift between the programmatic schema returned by
    // buildModelConfigurationSchema() and the static copy in package.json's
    // languageModelChatProviders[0].configuration.properties.
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as {
      contributes: {
        languageModelChatProviders: Array<{
          configuration: { properties: Record<string, unknown> };
        }>;
      };
    };
    const pkgProps = pkg.contributes.languageModelChatProviders[0]!.configuration.properties;
    const schemaProps = buildModelConfigurationSchema().properties;

    expect(Object.keys(schemaProps).sort()).toEqual(Object.keys(pkgProps).sort());
  });
});
