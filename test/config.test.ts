import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { mockGetConfiguration } = vi.hoisted(() => ({
  mockGetConfiguration: vi.fn(() => ({
    get: vi.fn((key: string, defaultValue: unknown) => defaultValue),
  })),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: mockGetConfiguration,
  },
}));

import { getModelAllowlist, getReasoningEffortWithStatus, getReasoningOutputWithStatus, getToolCallingStrategy, getToolCallingStrategyWithStatus, parseProviderConfiguration, resolveApiKey } from "../src/config.js";

describe("NanoGPT config — API key resolution", () => {
  const originalNanoGptApiKey = process.env.NANOGPT_API_KEY;

  beforeEach(() => {
    mockGetConfiguration.mockClear();
    mockGetConfiguration.mockImplementation(() => ({
      get: vi.fn((key: string, defaultValue: unknown) => {
        if (key === "apiKey") {
          return "";
        }
        return defaultValue;
      }),
    }));
    delete process.env.NANOGPT_API_KEY;
  });

  afterEach(() => {
    if (originalNanoGptApiKey === undefined) {
      delete process.env.NANOGPT_API_KEY;
    } else {
      process.env.NANOGPT_API_KEY = originalNanoGptApiKey;
    }
  });

  test("keeps API key resolution secure by default", async () => {
    const mockSecretsGet = vi.fn(async () => undefined);
    process.env.NANOGPT_API_KEY = "env-key";
    mockGetConfiguration.mockImplementation(() => ({
      get: vi.fn((key: string, defaultValue: unknown) => (key === "apiKey" ? "workspace-key" : defaultValue)),
    }));

    await expect(
      resolveApiKey({ secrets: { get: mockSecretsGet } } as never, undefined),
    ).resolves.toBeUndefined();
  });

  test("honors the explicit opt-in insecure fallback chain", async () => {
    const mockSecretsGet = vi.fn(async () => undefined);
    process.env.NANOGPT_API_KEY = "env-key";
    mockGetConfiguration.mockImplementation(() => ({
      get: vi.fn((key: string, defaultValue: unknown) => (key === "apiKey" ? "workspace-key" : defaultValue)),
    }));

    await expect(
      resolveApiKey({ secrets: { get: mockSecretsGet } } as never, undefined, { allowInsecureSources: true }),
    ).resolves.toBe("workspace-key");
  });

  test("falls back to the environment variable when the insecure opt-in path is enabled", async () => {
    const mockSecretsGet = vi.fn(async () => undefined);
    process.env.NANOGPT_API_KEY = "env-key";
    mockGetConfiguration.mockImplementation(() => ({
      get: vi.fn((key: string, defaultValue: unknown) => (key === "apiKey" ? "" : defaultValue)),
    }));

    await expect(
      resolveApiKey({ secrets: { get: mockSecretsGet } } as never, undefined, { allowInsecureSources: true }),
    ).resolves.toBe("env-key");
  });
});

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

describe("NanoGPT config — reasoning effort resolver", () => {
  beforeEach(() => {
    mockGetConfiguration.mockClear();
    mockGetConfiguration.mockImplementation(() => ({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    }));
  });

  test("returns undefined value for the auto sentinel", () => {
    expect(getReasoningEffortWithStatus({ reasoningEffort: "auto" })).toEqual({
      value: undefined,
    });
  });

  test("returns undefined value and no invalidValue for valid effort levels", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh"] as const) {
      expect(getReasoningEffortWithStatus({ reasoningEffort: effort })).toEqual({
        value: effort,
      });
    }
  });

  test("flags a typo as invalid and returns undefined value", () => {
    expect(getReasoningEffortWithStatus({ reasoningEffort: "hihg" })).toEqual({
      value: undefined,
      invalidValue: "hihg",
    });
  });

  test("flags an unrecognized non-empty value as invalid", () => {
    expect(getReasoningEffortWithStatus({ reasoningEffort: "turbo" })).toEqual({
      value: undefined,
      invalidValue: "turbo",
    });
  });

  test("reads from workspace settings when no provider config is set", () => {
    mockGetConfiguration.mockImplementation(() => ({
      get: vi.fn((key: string, defaultValue: unknown) =>
        key === "reasoningEffort" ? "medium" : defaultValue,
      ),
    }));

    expect(getReasoningEffortWithStatus(undefined)).toEqual({ value: "medium" });
  });
});

  describe("NanoGPT config — reasoning output with-status resolver", () => {
    beforeEach(() => {
      mockGetConfiguration.mockClear();
      mockGetConfiguration.mockImplementation(() => ({
        get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
      }));
    });

    test("returns valid value for hidden, visible, and native", () => {
      for (const output of ["hidden", "visible", "native"] as const) {
        expect(getReasoningOutputWithStatus({ reasoningOutput: output })).toEqual({
          value: output,
        });
      }
    });

    test("defaults to native when no reasoningOutput is configured", () => {
      expect(getReasoningOutputWithStatus({})).toEqual({ value: "native" });
    });

    test("flags an unrecognized value as invalid and falls back to native", () => {
      expect(getReasoningOutputWithStatus({ reasoningOutput: "invisible" })).toEqual({
        value: "native",
        invalidValue: "invisible",
      });
    });

    test("reads from workspace settings when no provider config is set", () => {
      mockGetConfiguration.mockImplementation(() => ({
        get: vi.fn((key: string, defaultValue: unknown) =>
          key === "reasoningOutput" ? "visible" : defaultValue,
        ),
      }));

      expect(getReasoningOutputWithStatus(undefined)).toEqual({ value: "visible" });
    });
  });

  describe("NanoGPT config — tool calling strategy with-status resolver", () => {
    beforeEach(() => {
      mockGetConfiguration.mockClear();
      mockGetConfiguration.mockImplementation(() => ({
        get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
      }));
    });

    test("returns valid value for native, auto, and bridge", () => {
      for (const strategy of ["native", "auto", "bridge"] as const) {
        expect(getToolCallingStrategyWithStatus({ toolCallingStrategy: strategy })).toEqual({
          value: strategy,
        });
      }
    });

    test("defaults to native when no toolCallingStrategy is configured", () => {
      expect(getToolCallingStrategyWithStatus({})).toEqual({ value: "native" });
    });

    test("flags an unrecognized value as invalid and falls back to native", () => {
      expect(getToolCallingStrategyWithStatus({ toolCallingStrategy: "bridged" })).toEqual({
        value: "native",
        invalidValue: "bridged",
      });
    });

    test("reads from workspace settings when no provider config is set", () => {
      mockGetConfiguration.mockImplementation(() => ({
        get: vi.fn((key: string, defaultValue: unknown) =>
          key === "toolCallingStrategy" ? "bridge" : defaultValue,
        ),
      }));

      expect(getToolCallingStrategyWithStatus(undefined)).toEqual({ value: "bridge" });
    });
  });

  describe("NanoGPT config — parseProviderConfiguration", () => {
    test("returns undefined for non-object input", () => {
      expect(parseProviderConfiguration(null)).toBeUndefined();
      expect(parseProviderConfiguration(undefined)).toBeUndefined();
      expect(parseProviderConfiguration("string")).toBeUndefined();
      expect(parseProviderConfiguration(42)).toBeUndefined();
      expect(parseProviderConfiguration([])).toBeUndefined();
    });

    test("returns a valid config for correctly-typed fields", () => {
      const result = parseProviderConfiguration({
        apiKey: "sk-test",
        routingMode: "paygo",
        reasoningEffort: "medium",
      });
      expect(result).toEqual({
        apiKey: "sk-test",
        routingMode: "paygo",
        reasoningEffort: "medium",
      });
    });

    test("omits absent fields", () => {
      const result = parseProviderConfiguration({ apiKey: "sk-test" });
      expect(result).toEqual({ apiKey: "sk-test" });
    });

    test("accepts a models array", () => {
      const result = parseProviderConfiguration({ models: ["gpt-5.4-mini"] });
      expect(result).toEqual({ models: ["gpt-5.4-mini"] });
    });

    test("returns undefined when a string field is the wrong type", () => {
      expect(parseProviderConfiguration({ routingMode: 42 })).toBeUndefined();
      expect(parseProviderConfiguration({ reasoningEffort: true })).toBeUndefined();
    });

    test("returns undefined when models is not an array", () => {
      expect(parseProviderConfiguration({ models: "not-an-array" })).toBeUndefined();
      expect(parseProviderConfiguration({ models: { id: "bad" } })).toBeUndefined();
    });

    test("allows models to be undefined (absent)", () => {
      const result = parseProviderConfiguration({ apiKey: "sk-test", models: undefined });
      expect(result).toEqual({ apiKey: "sk-test" });
    });

    test("returns empty config for an empty object", () => {
      expect(parseProviderConfiguration({})).toEqual({});
    });
  });
