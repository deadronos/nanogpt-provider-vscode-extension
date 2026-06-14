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

import { getModelAllowlist, getToolCallingStrategy, resolveApiKey } from "../src/config.js";

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
