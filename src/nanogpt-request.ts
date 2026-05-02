import {
  NANOGPT_BASE_URL,
  NANOGPT_SUBSCRIPTION_BASE_URL,
  type NanoGptChatMessage,
  type NanoGptReasoningEffort,
  type NanoGptReasoningOutput,
  type NanoGptRequest,
  type NanoGptRoutingMode,
  type VscodeLikeTool,
} from "./nanogpt-types.js";
import { toNanoGptTools } from "./nanogpt-message.js";

/**
 * Builds the full HTTP request configuration for a NanoGPT
 * chat completion call.
 *
 * Selects the appropriate base URL from the routing mode,
 * adds the `X-Provider` header in paygo mode when a provider
 * is specified, and assembles the JSON body with stream, tool,
 * reasoning, and token controls.
 *
 * @returns A {@link NanoGptRequest} with `url`, `headers`, and `body`.
 */
export function buildNanoGptChatCompletionRequest(params: {
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
}): NanoGptRequest {
  const baseUrl =
    params.routingMode === "subscription" ? NANOGPT_SUBSCRIPTION_BASE_URL : NANOGPT_BASE_URL;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.apiKey}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };

  if (params.routingMode === "paygo" && params.provider?.trim()) {
    headers["X-Provider"] = params.provider.trim();
  }

  const tools = toNanoGptTools(params.tools);

  return {
    url: `${baseUrl}/chat/completions`,
    headers,
    body: JSON.stringify({
      model: params.modelId,
      messages: params.messages,
      stream: true,
      ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
      ...(tools ? { tools } : {}),
      ...(tools && params.toolMode === "required" ? { tool_choice: "required" } : {}),
      ...(params.parallelToolCalls ? { parallel_tool_calls: true } : {}),
      ...(params.reasoningEffort
        ? { reasoning_effort: params.reasoningEffort }
        : {}),
      ...(params.reasoningOutput === "hidden"
        ? { reasoning: { exclude: true } }
        : { reasoning: { exclude: false } }),
    }),
  };
}
