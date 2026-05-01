import {
  buildNanoGptChatCompletionRequest,
  collectSseTextDeltas,
  mapNanoGptModelsToVscode,
  type NanoGptChatMessage,
  type NanoGptRoutingMode,
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
    const response = await this.fetchImpl(`${baseUrl}/models`, {
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
    signal?: AbortSignal;
    onText: (text: string) => void;
  }): Promise<void> {
    const request = buildNanoGptChatCompletionRequest(params);
    const response = await this.fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: params.signal,
    });

    if (!response.ok) {
      throw new Error(`NanoGPT chat request failed with HTTP ${response.status}`);
    }

    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const delta of collectSseTextDeltas(lines)) {
        params.onText(delta);
      }
    }

    buffer += decoder.decode();
    for (const delta of collectSseTextDeltas(buffer.split(/\r?\n/))) {
      params.onText(delta);
    }
  }
}
