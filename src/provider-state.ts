import type * as vscode from "vscode";

export const PERSISTED_INVALID_REASONING_EFFORTS_KEY = "nanogpt.warnedInvalidReasoningEfforts";
export const PERSISTED_INVALID_REASONING_OUTPUTS_KEY = "nanogpt.warnedInvalidReasoningOutputs";
export const PERSISTED_INVALID_TOOL_CALLING_STRATEGIES_KEY = "nanogpt.warnedInvalidToolCallingStrategies";

/**
 * Restores the invalid-value warning dedup sets from
 * {@link vscode.ExtensionContext.workspaceState} so that users who
 * reload the extension window do not see the same configuration
 * typo warning every time.
 */
export function hydrateWarnedSets(
  workspaceState: vscode.Memento | undefined,
  warnedInvalidReasoningEfforts: Set<string>,
  warnedInvalidReasoningOutputs: Set<string>,
  warnedInvalidToolCallingStrategies: Set<string>,
): void {
  if (!workspaceState) {
    return;
  }

  const hydrateSet = (key: string, target: Set<string>) => {
    try {
      const stored = workspaceState.get<string[]>(key);
      if (Array.isArray(stored)) {
        for (const value of stored) {
          target.add(value);
        }
      }
    } catch {
      // best-effort; the Set will be repopulated on next invalid value
    }
  };

  hydrateSet(PERSISTED_INVALID_REASONING_EFFORTS_KEY, warnedInvalidReasoningEfforts);
  hydrateSet(PERSISTED_INVALID_REASONING_OUTPUTS_KEY, warnedInvalidReasoningOutputs);
  hydrateSet(PERSISTED_INVALID_TOOL_CALLING_STRATEGIES_KEY, warnedInvalidToolCallingStrategies);
}

/**
 * Persists an updated warned-values set to workspaceState. Fire-and-forget;
 * failures are intentionally silent so chat throughput is never affected.
 */
export function persistWarnedSet(
  workspaceState: vscode.Memento | undefined,
  key: string,
  values: Set<string>,
): void {
  if (!workspaceState) {
    return;
  }

  (async () => {
    try {
      await workspaceState.update(key, [...values]);
    } catch {
      // best-effort; the warning has already been logged
    }
  })();
}
import type { NanoGptLogger } from "./client.js";

/**
 * Emits a one-time warning for an invalid configuration value and
 * persists the fact that the user has been warned so the same typo
 * does not spam the output log on every chat turn.
 *
 * @returns `true` when the warning was just emitted (first occurrence),
 *          `false` when it was already warned before.
 */
export function warnOnceInvalidConfig(params: {
  logger: NanoGptLogger;
  warnedSet: Set<string>;
  persistKey: string;
  workspaceState: vscode.Memento | undefined;
  fieldName: string;
  invalidValue: string;
  validValues: string;
  fallbackDescription: string;
}): boolean {
  if (params.warnedSet.has(params.invalidValue)) {
    return false;
  }

  params.warnedSet.add(params.invalidValue);
  persistWarnedSet(params.workspaceState, params.persistKey, params.warnedSet);
  params.logger.warn(
    `NanoGPT ${params.fieldName} '${params.invalidValue}' is not one of ${params.validValues}; falling back to ${params.fallbackDescription}`,
  );
  return true;
}
