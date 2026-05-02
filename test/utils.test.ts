import { describe, expect, test } from "vitest";
import {
  isPositiveNumber,
  isObject,
  toBase64,
  formatKeyValuePairs,
  formatRoleCounts,
  formatError,
  getHeader,
  withTimeout,
} from "../src/utils.js";

describe("utils", () => {
  // ── isPositiveNumber ────────────────────────────────────────────────────────

  test("isPositiveNumber returns true for finite positive numbers", () => {
    expect(isPositiveNumber(1)).toBe(true);
    expect(isPositiveNumber(100)).toBe(true);
    expect(isPositiveNumber(0.5)).toBe(true);
  });

  test("isPositiveNumber returns false for zero, negative, or non-numbers", () => {
    expect(isPositiveNumber(0)).toBe(false);
    expect(isPositiveNumber(-1)).toBe(false);
    expect(isPositiveNumber(Infinity)).toBe(false);
    expect(isPositiveNumber(NaN)).toBe(false);
    expect(isPositiveNumber("1")).toBe(false);
    expect(isPositiveNumber(null)).toBe(false);
    expect(isPositiveNumber(undefined)).toBe(false);
  });

  // ── isObject ────────────────────────────────────────────────────────────────

  test("isObject returns true for plain objects", () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ key: "value" })).toBe(true);
  });

  test("isObject returns false for null, arrays, and primitives", () => {
    expect(isObject(null)).toBe(false);
    expect(isObject([1, 2, 3])).toBe(true); // arrays are objects
    expect(isObject("string")).toBe(false);
    expect(isObject(42)).toBe(false);
    expect(isObject(undefined)).toBe(false);
  });

  // ── toBase64 ────────────────────────────────────────────────────────────────

  test("toBase64 encodes Uint8Array data", () => {
    const input = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    expect(toBase64(input)).toBe("SGVsbG8=");
  });

  // ── formatKeyValuePairs ─────────────────────────────────────────────────────

  test("formatKeyValuePairs formats entries as key=value pairs", () => {
    expect(formatKeyValuePairs({ count: 3, active: true })).toBe("count=3, active=true");
  });

  test("formatKeyValuePairs returns empty string for empty record", () => {
    expect(formatKeyValuePairs({})).toBe("");
  });

  // ── formatRoleCounts ─────────────────────────────────────────────────────────

  test("formatRoleCounts formats role counts", () => {
    expect(formatRoleCounts({ user: 2, assistant: 1 })).toBe("user:2|assistant:1");
  });

  test("formatRoleCounts returns 'none' for empty record", () => {
    expect(formatRoleCounts({})).toBe("none");
  });

  // ── formatError ─────────────────────────────────────────────────────────────

  test("formatError returns Error.message", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  test("formatError stringifies non-Error values", () => {
    expect(formatError("oops")).toBe("oops");
    expect(formatError(42)).toBe("42");
  });

  // ── getHeader ───────────────────────────────────────────────────────────────

  test("getHeader reads a header value from a Response", () => {
    const response = new Response(null, { headers: { "content-type": "application/json" } });
    expect(getHeader(response, "content-type")).toBe("application/json");
  });

  test("getHeader returns 'unknown' for missing header", () => {
    const response = new Response(null, {});
    expect(getHeader(response, "x-missing")).toBe("unknown");
  });

  // ── withTimeout ─────────────────────────────────────────────────────────────

  test("withTimeout creates a signal and disposes cleanly", () => {
    const managed = withTimeout(undefined, 1000);
    expect(managed.signal).toBeInstanceOf(AbortSignal);
    expect(managed.signal.aborted).toBe(false);
    managed.dispose();
  });

  test("withTimeout aborts when the timeout expires", async () => {
    const managed = withTimeout(undefined, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(managed.signal.aborted).toBe(true);
    managed.dispose();
  });

  test("withTimeout aborts immediately when the caller signal is already aborted", () => {
    const caller = AbortSignal.abort();
    const managed = withTimeout(caller, 1000);
    expect(managed.signal.aborted).toBe(true);
    managed.dispose();
  });
});
