import {
  buildNanoGptChatCompletionRequest,
  NanoGptSseParser,
  mapNanoGptModelsToVscode,
  type NanoGptChatMessage,
  type NanoGptReasoningEffort,
  type NanoGptReasoningOutput,
  type NanoGptResponsePart,
  type NanoGptRoutingMode,
  type VscodeLikeTool,
  type VscodeModelMetadata,
} from "./nanogpt.js";

type FetchLike = typeof fetch;

export class NanoGptClient {
  private readonly fetchImpl: FetchLike;

  constructor(fetchImpl: FetchLike = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async discoverModels(params: {
    apiKey: string;
    routingMode: NanoGptRoutingMode;
    allowlist?: readonly string[];
    signal?: AbortSignal;
  }): Promise<VscodeModelMetadata[]> {
    const baseUrl =
      params.routingMode === "subscription"
        ? "https://nano-gpt.com/api/subscription/v1"
        : "https://nano-gpt.com/api/v1";
    const url = new URL(`${baseUrl}/models`);
    url.searchParams.set("detailed", "true");

    const response = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        Accept: "application/json",
      },
      signal: params.signal,
    });

    if (!response.ok) {
      throw new Error(`NanoGPT model discovery failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    const entries = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
        ? (payload as { data: unknown[] }).data
        : [];

    return mapNanoGptModelsToVscode(entries, params.allowlist);
  }

  async streamChatCompletions(params: {
    apiKey: string;
    modelId: string;
    messages: readonly NanoGptChatMessage[];
    routingMode: NanoGptRoutingMode;
    provider?: string;
    maxTokens?: number;
    tools?: readonly VscodeLikeTool[];
    toolMode?: "auto" | "required";
    reasoningEffort?: NanoGptReasoningEffort;
    reasoningOutput?: NanoGptReasoningOutput;
    parallelToolCalls?: boolean;
    signal?: AbortSignal;
    onText: (text: string) => void;
    onReasoning?: (text: string) => void;
    onToolCall?: (toolCall: Extract<NanoGptResponsePart, { type: "tool_call" }>) => void;
  }): Promise<void> {
    const request = buildNanoGptChatCompletionRequest({
      apiKey: params.apiKey,
      modelId: params.modelId,
      messages: params.messages,
      routingMode: params.routingMode,
      provider: params.provider,
      maxTokens: params.maxTokens,
      tools: params.tools,
      toolMode: params.toolMode,
      reasoningEffort: params.reasoningEffort,
      reasoningOutput: params.reasoningOutput,
      parallelToolCalls: params.parallelToolCalls,
    });
    const response = await this.fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: params.signal,
    });

    if (!response.ok) {
      let message = `NanoGPT chat request failed with HTTP ${response.status}`;
      try {
        const body = await response.json() as { error?: { message?: string; code?: string; type?: string } };
        if (body?.error?.message) {
          message = `[NanoGPT] ${body.error.message}${body.error.type ? ` (${body.error.type})` : ""}${body.error.code ? ` [${body.error.code}]` : ""}`;
        }
      } catch {
        // Use the default message if the body is not JSON.
      }
      throw new Error(message);
    }

    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new NanoGptSseParser();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      this.emitParts(parser.acceptLines(lines), params);
    }

    buffer += decoder.decode();
    this.emitParts(parser.acceptLines(buffer.split(/\r?\n/)), params);
  }

  private emitParts(
    parts: readonly NanoGptResponsePart[],
    params: {
      onText: (text: string) => void;
      onReasoning?: (text: string) => void;
      onToolCall?: (toolCall: Extract<NanoGptResponsePart, { type: "tool_call" }>) => void;
    },
  ): void {
    for (const part of parts) {
      if (part.type === "text") {
        params.onText(part.text);
      } else if (part.type === "reasoning") {
        params.onReasoning?.(part.text);
      } else {
        params.onToolCall?.(part);
      }
    }
  }
}
