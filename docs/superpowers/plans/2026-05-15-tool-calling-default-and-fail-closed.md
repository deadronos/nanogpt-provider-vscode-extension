# Tool-Calling Default and Fail-Closed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore `native` as the default tool-calling strategy, keep `auto` and `bridge` as explicit options, preserve the bridge repair retry, and move required-turn fail-closed warning emission into the VS Code provider layer while adding bridge telemetry counters.

**Architecture:** Keep bridge parsing, repair retry, and classification in `src/client.ts`, but return a structured result object instead of having the client own every user-facing warning text. Let `src/extension.ts` emit the required-turn warning text part and include bridge telemetry in request-scoped logging. Update coupled config/schema/docs defaults back to `native` and keep the existing raw-text fallback only for non-required bridge turns.

**Tech Stack:** TypeScript, VS Code Language Model Chat Provider API, Vitest, NodeNext ESM.

---

## File Map

- Modify: `src/client.ts`
  Purpose: return structured bridge outcome data, keep repair retry in transport, track telemetry counters, default omitted strategy to `native`.
- Modify: `src/extension.ts`
  Purpose: emit required-turn warning text parts, export the provider class for unit testing, include bridge telemetry in request logs.
- Modify: `src/config.ts`
  Purpose: default `toolCallingStrategy` resolution back to `native`.
- Modify: `src/nanogpt.ts`
  Purpose: update the model configuration schema default back to `native`.
- Modify: `package.json`
  Purpose: update provider/workspace configuration defaults and descriptions.
- Modify: `README.md`
  Purpose: document `native` as the default and explain that `auto` and `bridge` are opt-in.
- Modify: `CHANGELOG.md`
  Purpose: record the restored default and the extension-owned required-turn warning behavior.
- Modify: `docs/architecture/README.md`
  Purpose: keep the architecture summary aligned with the implementation.
- Modify: `docs/architecture/contracts-and-invariants.md`
  Purpose: update the default strategy invariant and required-turn fail-closed ownership.
- Modify: `docs/architecture/runtime-flows.md`
  Purpose: describe the updated routing and warning-emission flow.
- Modify: `test/client.test.ts`
  Purpose: cover native-as-default behavior plus structured bridge telemetry/result handling.
- Modify: `test/nanogpt.test.ts`
  Purpose: verify schema default coupling against the manifest.
- Create: `test/extension.test.ts`
  Purpose: verify the VS Code provider emits a warning text part for required-turn fail-closed results and logs bridge telemetry.

### Task 1: Restore `native` as the Default Strategy

**Files:**

- Modify: `test/client.test.ts`
- Modify: `test/nanogpt.test.ts`
- Modify: `src/config.ts`
- Modify: `src/client.ts`
- Modify: `src/nanogpt.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing tests for the restored default**

In `test/client.test.ts`, replace the current omitted-strategy auto-retry expectation with a native-default test:

```ts
  test("uses native tool calling when strategy is omitted", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        new Response(
          createReadableStream([
            'data: {"choices":[{"delta":{"content":"Let me do a broad integrity scan of the codebase."}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200 },
        ),
      );

    const client = new NanoGptClient(fetchImpl as typeof fetch);
    const texts: string[] = [];

    await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Review the project" }],
      routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a workspace file" }],
      onText: (text) => texts.push(text),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(texts).toEqual(["Let me do a broad integrity scan of the codebase."]);
  });
```

In `test/nanogpt.test.ts`, change the schema expectation:

```ts
    expect(models[0]?.configurationSchema).toMatchObject({
      properties: {
        toolCallingStrategy: {
          enum: ["native", "auto", "bridge"],
          default: "native",
        },
      },
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm test -- test/client.test.ts test/nanogpt.test.ts -t "uses native tool calling when strategy is omitted|advertises VS Code tool calling when NanoGPT reports tool-call support"
```

Expected: FAIL with one assertion still seeing two fetches or buffered auto-retry behavior, and one assertion still seeing `default: "auto"`.

- [ ] **Step 3: Implement the minimal default switch**

Update `src/config.ts`:

```ts
export function getToolCallingStrategy(
  providerConfiguration?: ProviderConfiguration,
  modelOptions?: { readonly [name: string]: unknown },
): NanoGptToolCallingStrategy {
  const value =
    typeof modelOptions?.toolCallingStrategy === "string"
      ? modelOptions.toolCallingStrategy
      : typeof providerConfiguration?.toolCallingStrategy === "string"
        ? providerConfiguration.toolCallingStrategy
        : getConfig().get<string>("toolCallingStrategy", "native");

  return value === "auto" || value === "bridge" || value === "native" ? value : "native";
}
```

Update the client fallback in `src/client.ts`:

```ts
const toolCallingStrategy = params.toolCallingStrategy ?? "native";
```

Update the schema default in `src/nanogpt.ts`:

```ts
      toolCallingStrategy: {
        type: "string",
        enum: ["native", "auto", "bridge"],
        enumItemLabels: ["Native", "Auto Retry", "Bridge"],
        default: "native",
        description:
          "Controls tool-calling reliability mode. Native forwards NanoGPT tools directly, auto retries empty or likely scaffolding-only native tool turns with a stricter bridge prompt, and bridge always uses the stricter bridge prompt.",
      },
```

Update both defaults in `package.json`:

```json
"toolCallingStrategy": {
  "type": "string",
  "enum": ["native", "auto", "bridge"],
  "enumItemLabels": ["Native", "Auto Retry", "Bridge"],
  "default": "native",
  "description": "Controls tool-calling reliability mode. Native forwards NanoGPT tools directly by default, auto retries empty or likely scaffolding-only native tool turns with a stricter bridge prompt, and bridge always uses the stricter bridge prompt."
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm test -- test/client.test.ts test/nanogpt.test.ts -t "uses native tool calling when strategy is omitted|advertises VS Code tool calling when NanoGPT reports tool-call support|buildModelConfigurationSchema properties match package.json languageModelChatProviders contribution"
```

Expected: PASS with the client making one request when strategy is omitted and schema/manifest defaults both reading `native`.

- [ ] **Step 5: Commit**

```bash
git add test/client.test.ts test/nanogpt.test.ts src/config.ts src/client.ts src/nanogpt.ts package.json
git commit -m "fix: restore native tool calling as default"
```

### Task 2: Return Structured Bridge Outcomes and Telemetry from the Client

**Files:**

- Modify: `test/client.test.ts`
- Modify: `src/client.ts`

- [ ] **Step 1: Write the failing client tests for structured bridge results**

In `test/client.test.ts`, change the required-turn fail-closed client test so it asserts a returned warning instead of emitted text, and add a telemetry assertion to the repair-success case:

```ts
  test("repairs a prose-only bridge turn with a second JSON-only retry", async () => {
    // existing mocked bridge + repair responses stay the same
    const result = await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Review the project" }],
      routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a workspace file" }],
      toolCallingStrategy: "bridge",
      onText: (text) => texts.push(text),
      onToolCall: (toolCall) => toolCalls.push(toolCall),
    });

    expect(result.bridgeTelemetry).toEqual({
      bridgeRepairAttempts: 1,
      bridgeRepairSuccesses: 1,
      bridgeRawTextFallbacks: 0,
      bridgeRequiredFailClosed: 0,
    });
    expect(result.requiredToolWarning).toBeUndefined();
  });

  test("returns a required-turn warning instead of client-emitted text when repair still returns no tool calls", async () => {
    const result = await client.streamChatCompletions({
      apiKey: "test-key",
      modelId: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Review the project" }],
      routingMode: "subscription",
      tools: [{ name: "read_file", description: "Read a workspace file" }],
      toolCallingStrategy: "bridge",
      toolMode: "required",
      onText: (text) => texts.push(text),
      onToolCall: (toolCall) => toolCalls.push(toolCall),
    });

    expect(texts).toEqual([]);
    expect(toolCalls).toEqual([]);
    expect(result.requiredToolWarning).toBe(
      "NanoGPT could not complete this required-tool turn safely. The model failed to return a valid structured tool call, so no tools were executed. Please retry or use a different model/provider.",
    );
    expect(result.bridgeTelemetry).toEqual({
      bridgeRepairAttempts: 1,
      bridgeRepairSuccesses: 0,
      bridgeRawTextFallbacks: 0,
      bridgeRequiredFailClosed: 1,
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm test -- test/client.test.ts -t "repairs a prose-only bridge turn with a second JSON-only retry|returns a required-turn warning instead of client-emitted text when repair still returns no tool calls"
```

Expected: FAIL because `streamChatCompletions()` still returns `void` and the required-turn path still emits warning text directly from the client.

- [ ] **Step 3: Implement the structured result and counters**

In `src/client.ts`, add result types and an empty counter factory:

```ts
export type NanoGptBridgeTelemetry = {
  bridgeRepairAttempts: number;
  bridgeRepairSuccesses: number;
  bridgeRawTextFallbacks: number;
  bridgeRequiredFailClosed: number;
};

export type NanoGptChatStreamResult = {
  bridgeTelemetry: NanoGptBridgeTelemetry;
  requiredToolWarning?: string;
};

function createEmptyBridgeTelemetry(): NanoGptBridgeTelemetry {
  return {
    bridgeRepairAttempts: 0,
    bridgeRepairSuccesses: 0,
    bridgeRawTextFallbacks: 0,
    bridgeRequiredFailClosed: 0,
  };
}
```

Change `streamChatCompletions()` to return `Promise<NanoGptChatStreamResult>` and thread the counters through the bridge path:

```ts
  async streamChatCompletions(...): Promise<NanoGptChatStreamResult> {
    const bridgeTelemetry = createEmptyBridgeTelemetry();
    // native path: return { bridgeTelemetry }
    // auto bridge retry path: pass bridgeTelemetry into streamChatCompletionsViaBridge()
    // bridge path: same
  }
```

Inside `streamChatCompletionsViaBridge()`:

```ts
    if (repairReason) {
      bridgeTelemetry.bridgeRepairAttempts += 1;
      // existing JSON-only repair request
    }

    if (turn.parsed.kind === "tool_calls") {
      if (repairReason) {
        bridgeTelemetry.bridgeRepairSuccesses += 1;
      }
      // emit tool calls, return { bridgeTelemetry }
    }

    if (params.toolMode === "required") {
      bridgeTelemetry.bridgeRequiredFailClosed += 1;
      return {
        bridgeTelemetry,
        requiredToolWarning: REQUIRED_TOOL_MODE_FAILURE_TEXT,
      };
    }

    if (turn.parsed.errorCode === "missing_bridge_object_turn" && fallbackBridgeText) {
      bridgeTelemetry.bridgeRawTextFallbacks += 1;
      params.onText(BRIDGE_RAW_TEXT_FALLBACK_PREFIX + fallbackBridgeText);
      return { bridgeTelemetry };
    }
```

Return `{ bridgeTelemetry }` from all successful non-required paths.

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm test -- test/client.test.ts -t "repairs a prose-only bridge turn with a second JSON-only retry|returns a required-turn warning instead of client-emitted text when repair still returns no tool calls|falls back to raw bridge text when the repair turn still omits JSON entirely"
```

Expected: PASS with structured bridge telemetry returned, no client-emitted required-turn warning text, and non-required raw-text fallback unchanged.

- [ ] **Step 5: Commit**

```bash
git add test/client.test.ts src/client.ts
git commit -m "feat: return structured bridge diagnostics from client"
```

### Task 3: Emit Required-Turn Warnings from the VS Code Provider Layer

**Files:**

- Create: `test/extension.test.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Write the failing provider test**

Create `test/extension.test.ts` with a minimal `vscode` mock and a fake client result:

```ts
import { describe, expect, test, vi } from "vitest";

const report = vi.fn();
const loggerEntries: string[] = [];

vi.mock("vscode", () => {
  class LanguageModelTextPart {
    constructor(public value: string) {}
  }

  class LanguageModelToolCallPart {
    constructor(
      public callId: string,
      public name: string,
      public input: unknown,
    ) {}
  }

  class LanguageModelDataPart {
    constructor(public data: Uint8Array, public mimeType: string) {}
  }

  class LanguageModelToolResultPart {
    constructor(public callId: string, public content: unknown[]) {}
  }

  return {
    LanguageModelTextPart,
    LanguageModelToolCallPart,
    LanguageModelDataPart,
    LanguageModelToolResultPart,
    LanguageModelChatToolMode: { Required: 1, Auto: 2 },
    workspace: { getConfiguration: () => ({ get: (_key: string, value: unknown) => value }) },
  };
});

describe("NanoGptLanguageModelProvider", () => {
  test("emits a warning text part when the client fails closed on a required bridge turn", async () => {
    const { NanoGptLanguageModelProvider } = await import("../src/extension.js");

    const client = {
      streamChatCompletions: vi.fn().mockResolvedValue({
        bridgeTelemetry: {
          bridgeRepairAttempts: 1,
          bridgeRepairSuccesses: 0,
          bridgeRawTextFallbacks: 0,
          bridgeRequiredFailClosed: 1,
        },
        requiredToolWarning:
          "NanoGPT could not complete this required-tool turn safely. The model failed to return a valid structured tool call, so no tools were executed. Please retry or use a different model/provider.",
      }),
    };

    const logger = {
      trace: (message: string) => loggerEntries.push(`trace:${message}`),
      debug: (message: string) => loggerEntries.push(`debug:${message}`),
      info: (message: string) => loggerEntries.push(`info:${message}`),
      warn: (message: string) => loggerEntries.push(`warn:${message}`),
      error: (message: string) => loggerEntries.push(`error:${message}`),
    };

    const provider = new NanoGptLanguageModelProvider(
      { secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() } } as never,
      client as never,
      logger as never,
    );

    await provider.provideLanguageModelChatResponse(
      { id: "gpt-5.4-mini", internal: { parallelToolCalls: false } } as never,
      [{ role: 1, content: [new (await import("vscode")).LanguageModelTextPart("Review")] }] as never,
      {
        configuration: {
          apiKey: "test-key",
          routingMode: "subscription",
          provider: "",
          reasoningOutput: "native",
          toolCallingStrategy: "bridge",
        },
        tools: [{ name: "read_file", description: "Read a file" }],
        toolMode: (await import("vscode")).LanguageModelChatToolMode.Required,
      },
      { report } as never,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as never,
    );

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        value:
          "NanoGPT could not complete this required-tool turn safely. The model failed to return a valid structured tool call, so no tools were executed. Please retry or use a different model/provider.",
      }),
    );
    expect(loggerEntries.join("\n")).toContain("bridgeRepairAttempts=1");
    expect(loggerEntries.join("\n")).toContain("bridgeRequiredFailClosed=1");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm test -- test/extension.test.ts
```

Expected: FAIL because `NanoGptLanguageModelProvider` is not exported yet and `provideLanguageModelChatResponse()` does not emit a provider-owned warning text part or include bridge telemetry in its request logs.

- [ ] **Step 3: Implement the provider-owned warning path and telemetry logging**

In `src/extension.ts`, export the provider class and consume the structured client result:

```ts
export class NanoGptLanguageModelProvider implements ChatProviderApi {
  // existing class body
}
```

Update `provideLanguageModelChatResponse()`:

```ts
      const streamResult = await this.client.streamChatCompletions({
        apiKey,
        modelId: model.id,
        messages: toNanoGptMessages(toCoreMessages(messages)),
        routingMode,
        provider,
        maxTokens: options.modelOptions?.maxTokens,
        tools: options.tools,
        toolMode: toToolMode(options.toolMode),
        reasoningEffort,
        reasoningOutput,
        toolCallingStrategy,
        parallelToolCalls: model.internal?.parallelToolCalls,
        signal: abortSignal.signal,
        requestId,
        onText: (text) => {
          responseSummary.textDeltas += 1;
          responseSummary.textChars += text.length;
          progress.report(new vscode.LanguageModelTextPart(text));
        },
        onReasoning: (text) => {
          responseSummary.reasoningDeltas += 1;
          responseSummary.reasoningChars += text.length;
          if (reasoningOutput === "hidden") {
            return;
          }
          const thinkingPart = createThinkingPart(text);
          if (thinkingPart) {
            progress.report(thinkingPart);
          } else if (reasoningOutput === "visible") {
            progress.report(new vscode.LanguageModelTextPart(text));
          }
        },
        onToolCall: (toolCall) => {
          responseSummary.toolCalls += 1;
          progress.report(
            new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input),
          );
        },
      });

      if (streamResult.requiredToolWarning) {
        responseSummary.textDeltas += 1;
        responseSummary.textChars += streamResult.requiredToolWarning.length;
        progress.report(new vscode.LanguageModelTextPart(streamResult.requiredToolWarning));
      }
```

Append bridge counters to the debug result details log:

```ts
      this.logger.debug(
        `[${requestId}] chat request result details (${formatKeyValuePairs({
          textChars: responseSummary.textChars,
          reasoningChars: responseSummary.reasoningChars,
          bridgeRepairAttempts: streamResult.bridgeTelemetry.bridgeRepairAttempts,
          bridgeRepairSuccesses: streamResult.bridgeTelemetry.bridgeRepairSuccesses,
          bridgeRawTextFallbacks: streamResult.bridgeTelemetry.bridgeRawTextFallbacks,
          bridgeRequiredFailClosed: streamResult.bridgeTelemetry.bridgeRequiredFailClosed,
        })})`,
      );
```

- [ ] **Step 4: Run the provider test to verify it passes**

Run:

```bash
npm test -- test/extension.test.ts
```

Expected: PASS with one provider-emitted warning text part and bridge telemetry counters present in the request log details.

- [ ] **Step 5: Commit**

```bash
git add test/extension.test.ts src/extension.ts
git commit -m "feat: emit required tool warnings from provider"
```

### Task 4: Update Documentation and Final Coupled Text Surfaces

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/architecture/README.md`
- Modify: `docs/architecture/contracts-and-invariants.md`
- Modify: `docs/architecture/runtime-flows.md`

- [ ] **Step 1: Update the docs to match the implemented behavior**

Apply these edits:

```md
| `nanogpt.toolCallingStrategy` | Controls tool-calling reliability. Defaults to `native`. Use `auto` to retry empty or scaffolding-only native tool turns through the stricter bridge path, or `bridge` to always use the bridge contract. |
```

```md
- Restored `native` as the default `toolCallingStrategy` so the extension uses upstream native tool calling unless the user explicitly opts into `auto` or `bridge`.
- Moved required-turn fail-closed warning emission to the VS Code provider layer while preserving the single JSON-only bridge repair retry.
- Added bridge telemetry counters to request-scoped diagnostics so repair attempts, successes, raw-text fallbacks, and required-turn fail-closed outcomes are visible in logs.
```

```md
- `toolCallingStrategy` defaults to `native` when omitted or invalid
- `auto` remains an explicit opt-in retry mode for empty or low-signal native tool turns
- required bridge turns emit a provider-owned warning text part when the repaired reply still yields no usable tool calls
```

- [ ] **Step 2: Run the schema-coupling test after the doc/manifest sync**

Run:

```bash
npm test -- test/nanogpt.test.ts -t "buildModelConfigurationSchema properties match package.json languageModelChatProviders contribution"
```

Expected: PASS, confirming the manifest and schema stay aligned while the docs reflect `native` as the default.

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md docs/architecture/README.md docs/architecture/contracts-and-invariants.md docs/architecture/runtime-flows.md
git commit -m "docs: document native tool calling as default"
```

### Task 5: Final Verification and Cleanup

**Files:**

- Modify: `test/client.test.ts` (only if any assertion drift remains)
- Modify: `test/extension.test.ts` (only if mocking cleanup is needed)

- [ ] **Step 1: Run the focused regression suite**

Run:

```bash
npm test -- test/client.test.ts test/extension.test.ts test/nanogpt.test.ts
```

Expected: PASS with the default-native tests, client bridge diagnostics tests, provider warning test, and schema parity checks all green.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run the full unit suite**

Run:

```bash
npm test
```

Expected: PASS with all Vitest files green.

- [ ] **Step 4: Commit the verified branch state**

```bash
git add test/client.test.ts test/extension.test.ts test/nanogpt.test.ts src/client.ts src/extension.ts src/config.ts src/nanogpt.ts package.json README.md CHANGELOG.md docs/architecture/README.md docs/architecture/contracts-and-invariants.md docs/architecture/runtime-flows.md
git commit -m "feat: tighten bridge diagnostics and restore native defaults"
```

## Self-Review Notes

- Spec coverage: the tasks cover the default switch, structured bridge repair telemetry, provider-owned required-turn warning emission, and the documentation updates described in the approved spec.
- Placeholder scan: no task uses `TODO`, `TBD`, or vague instructions such as “add appropriate error handling.”
- Type consistency: the plan consistently uses `NanoGptChatStreamResult`, `NanoGptBridgeTelemetry`, `requiredToolWarning`, and `NanoGptLanguageModelProvider` across the tasks.
