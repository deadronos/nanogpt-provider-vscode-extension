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

Inside VS Code, run `NanoGPT: Manage API Key` and paste your NanoGPT API key.
The key is stored in VS Code secret storage. The `nanogpt.apiKey` setting also
works, but secret storage is safer.

## Configuration

- `nanogpt.routingMode`: `subscription` or `paygo`.
- `nanogpt.provider`: optional upstream provider id sent as `X-Provider` in
  pay-as-you-go mode.
- `nanogpt.models`: optional model id allowlist. Leave empty to discover
  models from NanoGPT.

## Current Scope

This first implementation supports text chat completions over NanoGPT's
OpenAI-compatible streaming API, model discovery, and approximate token
counting. Tool calls and image input are surfaced in discovered metadata when
NanoGPT reports support, but the request bridge currently streams text deltas
only.

## Development

```bash
npm test
npm run typecheck
npm run build
```
