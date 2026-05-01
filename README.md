# NanoGPT Provider for VS Code

Unofficial VS Code extension that contributes NanoGPT models through VS Code's
Language Model Chat Provider API, making them available in supported Copilot
Chat model pickers.

## Requirements

- VS Code with Language Model Chat Provider support.
- A Copilot plan/policy that allows bring-your-own language model providers.
- A NanoGPT API key.

## Setup

Install dependencies and compile:

```bash
npm install
npm run build
```

Then launch the extension from VS Code's extension host or package it:

```bash
npm run package
```

Inside VS Code, use Chat: Manage Language Models and configure the NanoGPT
provider. VS Code stores the provider API key as a secret. The
`NanoGPT: Manage API Key` command and `nanogpt.apiKey` setting also work as
fallbacks, but the provider configuration flow is preferred.

## Configuration

- `nanogpt.routingMode`: `subscription` or `paygo`.
- `nanogpt.provider`: optional upstream provider id sent as `X-Provider` in
  pay-as-you-go mode.
- `nanogpt.models`: optional model id allowlist. Leave empty to discover
  models from NanoGPT.
- `nanogpt.reasoningEffort`: optional reasoning effort for reasoning-capable
  models: `auto`, `low`, `medium`, or `high`.
- `nanogpt.reasoningOutput`: controls streamed reasoning output. `native` uses
  VS Code's thinking part when available, `hidden` asks NanoGPT to exclude
  reasoning, and `visible` falls back to normal text if native thinking parts
  are unavailable.

## Current Scope

This implementation supports text chat completions, image input for
vision-capable models, detailed NanoGPT model discovery, approximate token
counting, VS Code tool calling, and reasoning/thinking controls for NanoGPT
models that report support. Tool definitions are sent to NanoGPT in
OpenAI-compatible `tools` format, prior tool calls/results are preserved in chat
history, streamed tool-call deltas are surfaced as `LanguageModelToolCallPart`,
and common streamed reasoning fields are surfaced through VS Code thinking parts
when available.

## Development

```bash
npm test
npm run typecheck
npm run build
```
