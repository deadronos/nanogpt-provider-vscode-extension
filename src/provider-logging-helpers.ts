import * as vscode from "vscode";
import type { NanoGptLogger } from "./client.js";
import { formatError, formatKeyValuePairs, isObject } from "./utils.js";

const VENDOR_ID = "nanogpt";

export type MessageSummary = {
  messageCount: number;
  roleCounts: Record<string, number>;
  textParts: number;
  dataParts: number;
  toolCallParts: number;
  toolResultParts: number;
};

export type RuntimeLanguageModelLike = vscode.LanguageModelChat & {
  vendor?: unknown;
  tokenizer?: unknown;
  capabilities?: unknown;
};

export function summarizeMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): MessageSummary {
  const summary: MessageSummary = {
    messageCount: messages.length,
    roleCounts: {},
    textParts: 0,
    dataParts: 0,
    toolCallParts: 0,
    toolResultParts: 0,
  };

  for (const message of messages) {
    const role = String(message.role);
    summary.roleCounts[role] = (summary.roleCounts[role] ?? 0) + 1;

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        summary.textParts += 1;
        continue;
      }

      if (part instanceof vscode.LanguageModelDataPart) {
        summary.dataParts += 1;
        continue;
      }

      if (part instanceof vscode.LanguageModelToolCallPart) {
        summary.toolCallParts += 1;
        continue;
      }

      if (part instanceof vscode.LanguageModelToolResultPart) {
        summary.toolResultParts += 1;
      }
    }
  }

  return summary;
}

export function summarizeTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): string {
  if (!tools || tools.length === 0) {
    return "count=0";
  }

  return formatKeyValuePairs({
    count: tools.length,
    names: tools.map((tool) => tool.name).join("|") || "none",
  });
}

function getRuntimeCapabilities(
  model: RuntimeLanguageModelLike,
): Record<string, unknown> | undefined {
  return isObject(model.capabilities) ? model.capabilities : undefined;
}

function getRuntimeCapabilityValue(model: RuntimeLanguageModelLike, key: string): string {
  const capabilities = getRuntimeCapabilities(model);
  if (!capabilities) {
    return "undefined";
  }

  const value = capabilities[key];
  return value === undefined ? "undefined" : String(value);
}

export function summarizeRuntimeModel(model: RuntimeLanguageModelLike): string {
  const capabilities = getRuntimeCapabilities(model);
  const capabilityKeys = capabilities ? Object.keys(capabilities).join("|") || "none" : "none";

  return formatKeyValuePairs({
    id: model.id,
    vendor: typeof model.vendor === "string" ? model.vendor : "unknown",
    family: model.family,
    version: model.version,
    tokenizer: model.tokenizer === undefined ? "undefined" : String(model.tokenizer),
    capabilityKeys,
    capabilityFamily: getRuntimeCapabilityValue(model, "family"),
    capabilityTokenizer: getRuntimeCapabilityValue(model, "tokenizer"),
  });
}

export async function logRuntimeModelResolution(logger: NanoGptLogger): Promise<void> {
  try {
    const models = await vscode.lm.selectChatModels({ vendor: VENDOR_ID });
    logger.debug(`[runtime] resolved NanoGPT models (${formatKeyValuePairs({ count: models.length })})`);

    for (const model of models.slice(0, 5)) {
      let helloTokenCount = "error";

      try {
        helloTokenCount = String(await model.countTokens("hello"));
      } catch (error) {
        helloTokenCount = `error:${formatError(error)}`;
      }

      logger.debug(
        `[runtime] selected model (${summarizeRuntimeModel(model as RuntimeLanguageModelLike)}, helloTokens=${helloTokenCount})`,
      );
    }
  } catch (error) {
    logger.warn(`[runtime] failed to resolve NanoGPT models: ${formatError(error)}`);
  }
}
