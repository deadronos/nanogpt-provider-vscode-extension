import { describe, expect, test, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, defaultValue: unknown) => defaultValue),
    })),
  },
}));

import { getModelAllowlist, getToolCallingStrategy } from "../src/config.js";

describe("NanoGPT config — tool calling strategy resolver", () => {

  test("defaults to native when no toolCallingStrategy is configured", () => {
    expect(getToolCallingStrategy({})).toBe("native");
  });

  test("falls back to native for invalid configured values", () => {
    expect(getToolCallingStrategy({ toolCallingStrategy: "invalid" })).toBe("native");
  });

  test("preserves explicit auto and bridge values", () => {
    expect(getToolCallingStrategy({ toolCallingStrategy: "auto" })).toBe("auto");
    expect(getToolCallingStrategy({ toolCallingStrategy: "bridge" })).toBe("bridge");
  });

  test("filters non-string values from ProviderConfiguration models array", () => {
    const result = getModelAllowlist({
      models: ["gpt-5.4-mini", 123, null, undefined, { id: "bad" }],
    });

    expect(result).toEqual(["gpt-5.4-mini"]);
  });
});
