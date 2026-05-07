import { createHash } from "node:crypto";

// ── Shared cross-cutting helpers ─────────────────────────────────────────────

/**
 * Type guard: returns `true` when the value is a finite positive number.
 */
export function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Type guard: returns `true` when `value` is a non-null, non-array object.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Encodes binary data as a base64 string.
 *
 * Uses a portable implementation so the core layer does not depend on
 * Node's `Buffer`. This keeps `src/nanogpt.ts` and `src/nanogpt-message.ts`
 * runnable in non-Node environments (e.g. web workers or browser tests).
 */
export function toBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.byteLength; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary);
}

/**
 * Returns a stable SHA-256 hex digest for a string.
 */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Formats a key-value record into a compact log string.
 */
export function formatKeyValuePairs(values: Record<string, string | number | boolean>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

/**
 * Formats a role-counts record into a compact log string.
 */
export function formatRoleCounts(roleCounts: Record<string, number>): string {
  if (Object.keys(roleCounts).length === 0) {
    return "none";
  }

  return Object.entries(roleCounts)
    .map(([role, count]) => `${role}:${count}`)
    .join("|");
}

/**
 * Safely formats an unknown error value as a string for logging.
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

// ── HTTP / abort utilities ───────────────────────────────────────────────────

/**
 * Reads a header value from a Response, returning `"unknown"` when the
 * header is absent.
 */
export function getHeader(response: Response, name: string): string {
  return response.headers?.get?.(name) ?? "unknown";
}

export type ManagedAbortSignal = {
  signal: AbortSignal;
  dispose(): void;
};

/**
 * Combines an optional caller-provided abort signal with a fixed timeout,
 * returning a single signal that aborts when either triggers.
 *
 * Uses manual {@link AbortController} composition for maximum compatibility.
 */
export function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): ManagedAbortSignal {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
  }, timeoutMs);

  if (signal) {
    const onAbort = () =>
      controller.abort((signal as AbortSignal & { reason?: unknown }).reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      controller.abort((signal as AbortSignal & { reason?: unknown }).reason);
    }

    return {
      signal: controller.signal,
      dispose() {
        clearTimeout(timeoutId);
        signal.removeEventListener("abort", onAbort);
      },
    };
  }

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeoutId);
    },
  };
}
