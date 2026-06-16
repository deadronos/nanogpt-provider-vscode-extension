import type * as vscode from "vscode";
import type { NanoGptLogger } from "./client.js";
import { formatError, formatKeyValuePairs, sha256Hex } from "./utils.js";
import type { VscodeModelMetadata } from "./nanogpt.js";

export const PERSISTED_MODEL_CACHE_KEY = "nanogpt.modelCache";
export const PERSISTED_MODEL_CACHE_VERSION = 1;

export type PersistedModelCache = {
  version: number;
  entries: Record<string, VscodeModelMetadata[]>;
};

/**
 * Builds a stable cache key from API key, routing mode, and optional
 * allowlist/family scoping. Uses SHA-256 so raw credentials are never
 * retained in cache-key strings.
 */
export function createModelCacheKey(
  apiKey: string,
  routingMode: string,
  allowlistKey?: string,
  families?: readonly string[],
): string {
  const apiKeyHash = sha256Hex(apiKey);
  const allowlistSegment = allowlistKey ?? "*";
  const familySegment = families && families.length > 0
    ? families.slice().sort().join(",")
    : "*";
  return `${routingMode}:${apiKeyHash}:${allowlistSegment}:${familySegment}`;
}

/**
 * Derives a stable set of "model family" tokens from an allowlist of
 * model ids. The heuristic strips size/quantization suffixes so that
 * `gpt-5.4-mini` and `gpt-5.4` collapse to the same `gpt-5.4` family
 * token, and `claude-sonnet-4.5` collapses to `claude-sonnet`. This
 * is good enough to partition the discovery cache by tokenization
 * family for common cases without requiring a client-side model
 * registry; ambiguous ids fall through to the original id.
 */
export function deriveFamilyTokensFromAllowlist(allowlist: readonly string[]): string[] {
  const families = new Set<string>();
  for (const raw of allowlist) {
    const id = String(raw ?? "").trim();
    if (!id) {
      continue;
    }
    // Strip trailing size/quantization markers such as `-mini`, `-pro`,
    // `-32k`, `-instruct`, `-chat`, `-base`, `-preview`.
    //
    // NOTE: The `\d{4,5}` alternative will also strip a 4-digit year suffix
    // (e.g. `gpt-2024` -> `gpt`). This is acceptable for discovery-cache
    // partitioning because the cache is keyed on tokenizer family, not on
    // exact identity, and year-suffixed OpenAI ids are not currently part of
    // the NanoGPT catalogue. If a year-suffixed model family needs distinct
    // cache partitioning in the future, tighten this alternative to only
    // match quantization-style numeric suffixes (e.g. `-\d{1,2}b`).
    const stripped = id.replace(
      /[-_.](mini|pro|max|nano|tiny|small|medium|large|xlarge|xxl|instruct|chat|base|preview|preview-\d+|\d+[kmb](?:-context)?|\d{4,5})$/i,
      "",
    );
    families.add(stripped || id);
  }
  return Array.from(families);
}

/**
 * Restores the in-memory model cache from VS Code globalState so a
 * cold start with a flaky network still has a last-known-good model list.
 */
export function hydrateModelCache(
  globalState: vscode.Memento,
  modelCache: Map<string, VscodeModelMetadata[]>,
  logger: NanoGptLogger,
): void {
  try {
    const persisted = globalState.get<PersistedModelCache>(PERSISTED_MODEL_CACHE_KEY);
    if (!persisted || persisted.version !== PERSISTED_MODEL_CACHE_VERSION) {
      return;
    }

    let entryCount = 0;
    for (const [key, value] of Object.entries(persisted.entries ?? {})) {
      if (Array.isArray(value)) {
        modelCache.set(key, value as VscodeModelMetadata[]);
        entryCount += 1;
      }
    }

    logger.debug(
      `[provider] model cache hydrated from globalState (${formatKeyValuePairs({ entryCount })})`,
    );
  } catch (error) {
    logger.warn(
      `[provider] failed to hydrate model cache from globalState: ${formatError(error)}`,
    );
  }
}

/**
 * Persists the in-memory model cache to VS Code globalState.
 */
export async function persistModelCache(
  globalState: vscode.Memento,
  modelCache: Map<string, VscodeModelMetadata[]>,
  logger: NanoGptLogger,
): Promise<void> {
  try {
    const entries: Record<string, VscodeModelMetadata[]> = {};
    for (const [key, value] of modelCache.entries()) {
      entries[key] = value;
    }

    await globalState.update(PERSISTED_MODEL_CACHE_KEY, {
      version: PERSISTED_MODEL_CACHE_VERSION,
      entries,
    });
  } catch (error) {
    logger.warn(
      `[provider] failed to persist model cache to globalState: ${formatError(error)}`,
    );
  }
}
