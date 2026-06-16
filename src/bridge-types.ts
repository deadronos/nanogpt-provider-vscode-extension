/**
 * Shared types for the NanoGPT tool-calling bridge.
 *
 * These types belong to the core transformation layer and must remain
 * free of VS Code imports and network I/O.
 */

export type NanoGptBridgeToolCall = {
  name: string;
  input: object;
};

export type NanoGptToolBridgeParseResult =
  | { kind: "final"; content: string }
  | { kind: "tool_calls"; content: string; toolCalls: NanoGptBridgeToolCall[] }
  | { kind: "invalid"; errorCode: string; message: string };

export type BridgeTurnPayload = {
  v?: unknown;
  mode?: unknown;
  message?: unknown;
  tool_calls?: unknown;
  toolCalls?: unknown;
  response?: unknown;
  result?: unknown;
  output?: unknown;
  payload?: unknown;
  data?: unknown;
  assistant?: unknown;
  turn?: unknown;
  name?: unknown;
  function?: unknown;
  arguments?: unknown;
  args?: unknown;
  parameters?: unknown;
  input?: unknown;
};
