import { tryParseJson } from "./utils.js";
import type { BridgeTurnPayload } from "./bridge-types.js";

// ── Code fence / text extraction helpers ─────────────────────────────────────

export function unwrapJsonCodeFence(text: string): string | undefined {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return match?.[1]?.trim();
}

export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function normalizeEscapedXmlText(text: string): string {
  return text.replace(/\\"/g, '"').replace(/\\'/g, "'");
}

// ── XML-like tool-call extraction ───────────────────────────────────────────

export function parseXmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const normalizedSource = normalizeEscapedXmlText(source);

  for (const match of normalizedSource.matchAll(/([A-Za-z_][A-Za-z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? "");
  }

  return attributes;
}

export function normalizeXmlParameterValue(
  attributes: Readonly<Record<string, string>>,
  value: string,
): unknown {
  const decodedValue = decodeXmlEntities(value).trim();
  if (!decodedValue) {
    return "";
  }

  const typeHint = (attributes.type ?? "").trim().toLowerCase();
  const treatAsString = attributes.string === "true" || typeHint === "string";
  if (treatAsString) {
    return decodedValue;
  }

  const parsedJson = tryParseJson(decodedValue);
  if (parsedJson !== undefined) {
    return parsedJson;
  }

  const treatAsBoolean = attributes.boolean === "true" || typeHint === "boolean";
  if (treatAsBoolean) {
    if (/^true$/i.test(decodedValue)) {
      return true;
    }
    if (/^false$/i.test(decodedValue)) {
      return false;
    }
  }

  const treatAsNumber =
    attributes.number === "true" ||
    attributes.integer === "true" ||
    typeHint === "number" ||
    typeHint === "integer";
  if (treatAsNumber) {
    const parsedNumber = Number(decodedValue);
    if (Number.isFinite(parsedNumber)) {
      return parsedNumber;
    }
  }

  return decodedValue;
}

/**
 * Extracts an XML-like `<tool_calls>` block from raw bridge text and
 * parses it into a {@link BridgeTurnPayload}. Returns `undefined` when
 * no valid `<tool_calls>` block is found.
 */
export function extractXmlLikeToolCallPayload(text: string): BridgeTurnPayload | undefined {
  const normalizedText = normalizeEscapedXmlText(text);
  const match = normalizedText.match(/([\s\S]*?)<tool_calls>([\s\S]*?)<\/tool_calls>([\s\S]*)/i);
  if (!match) {
    return undefined;
  }

  const [, before, toolCallsBlock, after] = match;
  const toolCalls = Array.from(
    toolCallsBlock.matchAll(/<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/gi),
  ).flatMap((toolCallMatch) => {
    const attributes = parseXmlAttributes(toolCallMatch[1] ?? "");
    const name = attributes.name?.trim();
    if (!name) {
      return [];
    }

    const body = toolCallMatch[2] ?? "";
    const parameters: Record<string, unknown> = {};
    for (const parameterMatch of body.matchAll(/<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi)) {
      const parameterAttributes = parseXmlAttributes(parameterMatch[1] ?? "");
      const parameterName = parameterAttributes.name?.trim();
      if (!parameterName) {
        continue;
      }

      parameters[parameterName] = normalizeXmlParameterValue(
        parameterAttributes,
        parameterMatch[2] ?? "",
      );
    }

    const bodyWithoutParameters = body
      .replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi, "")
      .trim();

    return [{
      name,
      arguments:
        Object.keys(parameters).length > 0
          ? parameters
          : bodyWithoutParameters
            ? decodeXmlEntities(bodyWithoutParameters)
            : {},
    }];
  });

  if (toolCalls.length === 0) {
    return undefined;
  }

  const message = [before.trim(), after.trim()]
    .filter(Boolean)
    .map((part) => decodeXmlEntities(part))
    .join("\n\n")
    .trim();

  return {
    v: 1,
    mode: "tool",
    message,
    tool_calls: toolCalls,
  };
}
