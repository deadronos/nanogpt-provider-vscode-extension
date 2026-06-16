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
