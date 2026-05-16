import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NanoGptClient } from "../src/client.js";
import {
  buildModelConfigurationSchema,
  estimateTokenCount,
  mapNanoGptModelsToVscode,
} from "../src/nanogpt.js";

describe("NanoGPT core — model mapping, schema, token estimation", () => {
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
        family: "gpt-5.4-mini",
        version: "gpt-5.4-mini",
        maxInputTokens: 200000,
        maxOutputTokens: 32768,
        detail: "NanoGPT",
        tooltip: "NanoGPT model gpt-5.4-mini — 200,000 input / 32,768 output tokens",
        capabilities: {
          imageInput: true,
          toolCalling: true,
          family: "gpt-5.4-mini",
          tokenizer: "o200k_base",
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
      family: "test/model",
      tokenizer: "o200k_base",
    });
    expect(models[0]!.reasoning).toBe(true);
    expect(models[0]!.internal).toEqual({
      parallelToolCalls: true,
    });
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
      family: "moonshotai/kimi-k2.5:thinking",
      tokenizer: "o200k_base",
    });
    expect(models[0]?.reasoning).toBe(true);
    expect(models[0]?.configurationSchema).toMatchObject({
      properties: {
        reasoningEffort: {
          enum: ["auto", "none", "minimal", "low", "medium", "high", "xhigh"],
        },
        toolCallingStrategy: {
          enum: ["native", "auto", "bridge"],
          default: "native",
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

  test("includes tool-result text in token estimates", () => {
    const largeText = "a".repeat(4000); // 1000 tokens
    const message = {
      role: "user",
      content: [
        { kind: "text", value: "hello" },
        {
          callId: "call_1",
          content: [
            { kind: "text", value: largeText },
            { kind: "text", value: largeText },
          ],
        },
      ],
    };
    const result = estimateTokenCount(message);
    // 5 chars top-level + 8000 chars tool result = 8005 / 4 ≈ 2002
    expect(result).toBeGreaterThanOrEqual(2000);
    expect(result).toBeLessThanOrEqual(2010);
  });

  test("includes tool-result JSON binary payloads in token estimates", () => {
    const jsonPayload = '{"result":' + '"x"'.repeat(2000) + "}";
    const jsonBytes = new TextEncoder().encode(jsonPayload);
    const message = {
      role: "user",
      content: [
        { kind: "text", value: "summary" },
        {
          callId: "call_json",
          content: [{ data: jsonBytes, mimeType: "application/json" }],
        },
      ],
    };
    const result = estimateTokenCount(message);
    // "summary" (7) + '{"result":""...' (6011) = 6018 chars / 4 = 1505
    expect(result).toBe(1505);
  });

  test("includes tool-result text/* binary payloads in token estimates", () => {
    const textContent = "plain text result ".repeat(200);
    const textBytes = new TextEncoder().encode(textContent);
    const message = {
      role: "user",
      content: [
        {
          callId: "call_text",
          content: [{ data: textBytes, mimeType: "text/plain" }],
        },
      ],
    };
    const result = estimateTokenCount(message);
    // "plain text result " is 18 chars. 18 * 200 = 3600 chars / 4 = 900
    expect(result).toBeGreaterThanOrEqual(890);
    expect(result).toBeLessThanOrEqual(910);
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

    const paygoModels = await client.discoverModels({
      apiKey: "test-key",
      routingMode: "paygo",
    });
    expect(String(fetchCalls[fetchCalls.length - 1]?.[0])).toBe(
      "https://nano-gpt.com/api/v1/models?detailed=true",
    );
    expect(paygoModels[0]).toMatchObject({
      id: "moonshotai/kimi-k2.5:thinking",
      maxInputTokens: 262144,
      maxOutputTokens: 8192,
      capabilities: { imageInput: true, toolCalling: true },
      reasoning: true,
    });

    const subModels = await client.discoverModels({
      apiKey: "test-key",
      routingMode: "subscription",
    });
    expect(String(fetchCalls[fetchCalls.length - 1]?.[0])).toBe(
      "https://nano-gpt.com/api/subscription/v1/models?detailed=true",
    );
    expect(subModels[0]?.id).toBe("moonshotai/kimi-k2.5:thinking");
  });

  test("buildModelConfigurationSchema properties match package.json languageModelChatProviders contribution", () => {
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
    expect(schemaProps.toolCallingStrategy).toEqual(pkgProps.toolCallingStrategy);
  });

  test("prefers canonicalId over id when both are present", () => {
    const models = mapNanoGptModelsToVscode([
      { id: "raw-id", canonicalId: "canonical-id", name: "Model" },
    ]);
    expect(models[0]!.id).toBe("canonical-id");
  });

  test("filters out entries with empty or missing id", () => {
    const models = mapNanoGptModelsToVscode([
      { id: "", name: "No ID" },
      { name: "Also No ID" },
      { id: "valid-model", name: "Valid" },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe("valid-model");
  });

  test("deduplicates models with the same id", () => {
    const models = mapNanoGptModelsToVscode([
      { id: "gpt-5.4-mini", name: "GPT Mini" },
      { id: "gpt-5.4-mini", name: "GPT Mini Duplicate" },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe("gpt-5.4-mini");
  });

  test("uses default context window and max output tokens when fields are absent", () => {
    const models = mapNanoGptModelsToVscode([{ id: "bare-model", name: "Bare" }]);
    expect(models[0]!.maxOutputTokens).toBe(32768);
    expect(models[0]!.maxInputTokens).toBe(200000);
  });

  test("accepts contextWindow and maxTokens as aliases for context_length and max_output_tokens", () => {
    const models = mapNanoGptModelsToVscode([
      {
        id: "alias-model",
        name: "Alias",
        contextWindow: 100000,
        maxTokens: 4096,
        capabilities: {},
      },
    ]);
    expect(models[0]!.maxOutputTokens).toBe(4096);
    expect(models[0]!.maxInputTokens).toBe(100000);
  });

  test("maxInputTokens follows the reported context window even when maxOutputTokens is larger", () => {
    const models = mapNanoGptModelsToVscode([
      { id: "odd-model", name: "Odd", context_length: 100, max_output_tokens: 200 },
    ]);
    expect(models[0]!.maxInputTokens).toBe(100);
  });

  test("maps live-like NanoGPT payload values without subtracting output from input", () => {
    const models = mapNanoGptModelsToVscode([
      {
        id: "deepseek/deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        context_length: 1048576,
        max_output_tokens: 384000,
        capabilities: { reasoning: true, tool_calling: true },
      },
      {
        id: "zai-org/glm-5.1",
        name: "GLM 5.1",
        context_length: 200000,
        max_output_tokens: 131072,
        capabilities: { reasoning: true, tool_calling: true },
      },
      {
        id: "moonshotai/kimi-k2.6",
        name: "Kimi K2.6",
        context_length: 256000,
        max_output_tokens: 65536,
        capabilities: { vision: true, tool_calling: true },
      },
    ]);

    expect(models.map((model) => ({
      id: model.id,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      tooltip: model.tooltip,
    }))).toEqual([
      {
        id: "deepseek/deepseek-v4-flash",
        maxInputTokens: 1048576,
        maxOutputTokens: 384000,
        tooltip: "NanoGPT model deepseek/deepseek-v4-flash — 1,048,576 input / 384,000 output tokens",
      },
      {
        id: "zai-org/glm-5.1",
        maxInputTokens: 200000,
        maxOutputTokens: 131072,
        tooltip: "NanoGPT model zai-org/glm-5.1 — 200,000 input / 131,072 output tokens",
      },
      {
        id: "moonshotai/kimi-k2.6",
        maxInputTokens: 256000,
        maxOutputTokens: 65536,
        tooltip: "NanoGPT model moonshotai/kimi-k2.6 — 256,000 input / 65,536 output tokens",
      },
    ]);
  });

  test("maps vision capability alias to imageInput", () => {
    const models = mapNanoGptModelsToVscode([
      {
        id: "vision-model",
        name: "Vision",
        context_length: 50000,
        vision: true,
        tool_calling: false,
      },
    ]);
    expect(models[0]!.capabilities.imageInput).toBe(true);
  });

  test("filters models not in the allowlist", () => {
    const models = mapNanoGptModelsToVscode(
      [
        { id: "model-a", name: "A" },
        { id: "model-b", name: "B" },
        { id: "model-c", name: "C" },
      ],
      ["model-a", "model-c"],
    );
    expect(models.map((m) => m.id)).toEqual(["model-a", "model-c"]);
  });

  test("prefers discovered family and version metadata when provided", () => {
    const models = mapNanoGptModelsToVscode([
      {
        id: "moonshotai/kimi-k2.5:thinking",
        name: "Kimi K2.5 Thinking",
        family: "kimi-k2.5",
        version: "thinking",
      },
    ]);

    expect(models[0]).toMatchObject({
      family: "kimi-k2.5",
      version: "thinking",
      capabilities: {
        family: "kimi-k2.5",
        tokenizer: "o200k_base",
      },
    });
  });

  test("maps legacy GPT families to cl100k tokenizer hints", () => {
    const models = mapNanoGptModelsToVscode([
      {
        id: "gpt-4-turbo",
        name: "GPT-4 Turbo",
      },
    ]);

    expect(models[0]).toMatchObject({
      capabilities: {
        family: "gpt-4-turbo",
        tokenizer: "cl100k_base",
      },
    });
  });

  test("adds 1024 tokens per image in message content", () => {
    const count = estimateTokenCount({
      role: "user",
      content: [
        { value: "describe this" },
        { data: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" },
      ],
    });
    expect(count).toBe(4 + 1024);
  });

  test("returns minimum of 1 for empty string", () => {
    expect(estimateTokenCount("")).toBe(1);
  });

  test("includes tool definition tokens in message estimates", () => {
    const message = {
      role: "user",
      content: [{ kind: "text", value: "hello" }],
    };

    const tools = [
      {
        name: "read_file",
        description: "Read a workspace file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        } as object,
      },
    ];

    const withoutTools = estimateTokenCount(message);
    const withTools = estimateTokenCount(message, tools);

    expect(withoutTools).toBe(2);
    expect(withTools).toBeGreaterThanOrEqual(20);
    expect(withTools).toBeLessThanOrEqual(31);
  });
});
