# Tool-Calling Defaults, Bridge Repair Telemetry, and Required-Turn Fail-Closed

## Summary

This change set does three related things:

1. Switches the default `toolCallingStrategy` back to `native`.
2. Keeps `auto` and `bridge` available as explicit opt-in reliability modes.
3. Preserves the new bridge repair retry, but routes required-turn fail-closed messaging through the VS Code integration layer instead of hard-coding all user-facing fallback text in the transport client.

The goal is to restore the cleaner default behavior observed in a separate session while retaining the optional bridge-based recovery paths for users and models that need them.

## Motivation

The extension currently defaults tool-enabled chats to `auto`, which means tool-enabled native turns can be buffered and retried through the bridge path whenever the model emits no tool calls and only empty or scaffolding-like text. That behavior improves resilience for weaker tool-calling models, but it also changes the default runtime behavior for users whose upstream model already handles native tool calling correctly.

At the same time, the recent bridge improvements are still useful:

- a malformed bridge reply can often be recovered with one stricter JSON-only repair turn
- required-tool turns should not silently degrade into plain prose if the model never returns a usable tool call

The desired outcome is therefore not to remove bridge protections, but to make them opt-in again while tightening required-turn safety and observability.

## Goals

- Default `toolCallingStrategy` to `native` again across config resolution, schema, settings, docs, and tests.
- Keep `auto` and `bridge` working exactly as selectable strategies.
- Preserve the single JSON-only repair retry for malformed bridge replies.
- Fail closed for required bridge turns after repair when the model still does not return any usable tool calls.
- Surface the required-turn fail-closed outcome as a structured warning text part from the VS Code provider layer.
- Add request-scoped telemetry counters to existing logs for bridge repair and fail-closed outcomes.

## Non-Goals

- No persistence or analytics backend for telemetry.
- No new user setting beyond the existing `toolCallingStrategy` surface.
- No attempt to synthesize tool calls from plain prose.
- No change to the current non-required raw-text fallback behavior after a repair retry still returns plain prose.

## Current State

### Default Strategy

`toolCallingStrategy` currently defaults to `auto` in:

- workspace configuration resolution
- per-model configuration schema
- extension manifest settings
- docs and tests

### Required-Turn Handling

The bridge path now performs one JSON-only repair retry for malformed replies. When `toolMode: "required"` still yields no usable tool calls, the client currently emits a fail-closed text message itself. That keeps the transport safe, but it places final user-facing output ownership in the transport layer rather than the VS Code layer.

### Telemetry

The extension already emits request-scoped logs for chat lifecycle events, but it does not currently summarize bridge repair activity or required-turn fail-closed outcomes in a dedicated, request-scoped way.

## Proposed Design

### 1. Restore `native` as the Default Strategy

The default strategy changes from `auto` back to `native` in all coupled locations:

- `src/config.ts`
- `src/nanogpt.ts`
- `package.json`
- `README.md`
- `docs/architecture/contracts-and-invariants.md`
- any related architecture/runtime docs and tests

Behavioral effect:

- a tool-enabled turn with no explicit strategy uses native tool calling only
- bridge retries happen only when the user or model config explicitly chooses `auto` or `bridge`

This keeps the cleaner default path for models that already behave well while retaining explicit recovery modes for problem providers.

### 2. Keep Bridge Repair Retry in the Client

The bridge repair retry remains transport-owned in `src/client.ts` because it is part of tool-routing and bridge-response handling, not a VS Code UI concern.

The client continues to:

- build the initial bridge request
- parse the bridged response
- issue one JSON-only repair turn when the bridge reply is malformed or when a required-tool bridged reply does not produce usable tool calls
- decide whether the repaired response yields tool calls, a valid final bridged answer, or a fallback condition

This preserves the strict no-guessing boundary: the client may retry for structured compliance, but it never infers tool calls from prose.

### 3. Move Required-Turn User Messaging to the Extension Layer

The transport client should not be the final owner of VS Code-facing warning text for required-turn fail-closed behavior.

Instead, the client will expose a structured outcome that indicates:

- whether a repair turn was attempted
- whether it succeeded
- whether raw-text fallback was used
- whether a required turn failed closed after repair

The extension layer in `src/extension.ts` will use that structured outcome to emit a `LanguageModelTextPart` warning when a required-turn fail-closed condition occurs.

Why this boundary is better:

- `src/client.ts` remains VS Code-free
- `src/extension.ts` owns user-visible response shaping
- tests can validate transport behavior separately from VS Code response-part behavior

### 4. Logging-Based Telemetry Counters

Add request-scoped counters for bridge-specific outcomes and include them in the existing chat completion logs.

Minimum counters:

- `bridgeRepairAttempts`
- `bridgeRepairSuccesses`
- `bridgeRawTextFallbacks`
- `bridgeRequiredFailClosed`

These counters should be emitted in the request completion log path and, when helpful, in failure logs as well.

This design intentionally uses existing structured log output instead of creating a new telemetry subsystem.

### 5. Preserve Non-Required Raw-Text Fallback

Non-required bridge turns should keep the current best-effort raw-text fallback when the model still returns prose after the repair retry.

That means:

- `toolMode !== "required"`: plain-prose bridge reply after repair may still be surfaced with the raw-text fallback prefix
- `toolMode === "required"`: no raw prose should be surfaced as if it were a safe tool outcome

This keeps optional bridge mode usable for exploratory or review-style prompts while preserving the strict safety boundary for required tool execution.

## File-Level Plan

### `src/client.ts`

- Keep bridge repair retry logic.
- Introduce or expand a transport-level structured result/outcome shape for bridge execution.
- Track per-request bridge counters during chat execution.
- Stop finalizing required-turn fail-closed output as only a hard-coded user message in the client.

### `src/extension.ts`

- Consume the structured bridge outcome returned by the client.
- When the client reports required-turn fail-closed, emit a warning `LanguageModelTextPart` and end the turn without throwing.
- Include the bridge counters in request-scoped completion/failure logging.

### `src/config.ts`

- Change the default configuration fallback for `toolCallingStrategy` to `native`.

### `src/nanogpt.ts`

- Change schema default values for `toolCallingStrategy` to `native`.

### `package.json`

- Change both provider configuration and workspace setting defaults/descriptions so `native` is the documented default again.

### Docs

Update:

- `README.md`
- `CHANGELOG.md`
- `docs/architecture/README.md`
- `docs/architecture/contracts-and-invariants.md`
- `docs/architecture/runtime-flows.md`

### Tests

Update or add coverage in:

- `test/client.test.ts`
- `test/nanogpt.test.ts`
- extension-level tests if present for response-part behavior; otherwise add the minimal new unit coverage at the closest existing seam

## Validation Plan

### Red-Green Tests

Add failing tests first for:

1. default `toolCallingStrategy` resolving to `native`
2. schema/config defaults reflecting `native`
3. required bridge fail-closed producing a structured warning text part at the VS Code layer without throwing
4. request logs including bridge telemetry counters

Existing bridge repair tests should continue to cover:

- repair retry success
- raw-text fallback after repair still omits JSON
- required-turn fail-closed after repair still yields no usable tool calls

### Verification Commands

- `npm test -- test/client.test.ts test/nanogpt.test.ts`
- `npm run typecheck`
- `npm test`

## Risks and Mitigations

### Risk: Logging contract becomes inconsistent

Mitigation:

- add counters in a single request-scoped summary path rather than sprinkling ad hoc log messages

### Risk: Required-turn handling drifts between client and extension

Mitigation:

- keep the client authoritative for transport outcome classification
- keep the extension authoritative for user-visible response parts

### Risk: Default switch causes confusion for users who benefited from `auto`

Mitigation:

- update README, settings descriptions, and changelog to clearly state that `auto` and `bridge` remain available as opt-in reliability modes

## Recommended Implementation Order

1. Add failing tests for default strategy and required-turn extension warning behavior.
2. Refactor the client to surface structured bridge outcomes plus counters.
3. Update the extension to emit warning text parts and include counters in logs.
4. Change default strategy values across config, schema, manifest, docs, and tests.
5. Run focused verification, then full test suite.

## Acceptance Criteria

- Omitting `toolCallingStrategy` results in `native` behavior.
- Explicit `auto` and `bridge` strategies still behave as documented.
- Malformed bridge replies still get one JSON-only repair retry.
- Required bridge turns that still lack usable tool calls after repair do not execute tools, do not throw, and do emit a warning text part.
- Request logs include bridge repair/fail-closed counters.
- Tests, typecheck, and the full unit suite pass.
