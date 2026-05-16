# Context Length Means Max Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct NanoGPT model metadata mapping so `context_length` / `contextWindow` is reported directly as `maxInputTokens`, while `max_output_tokens` / `maxTokens` remains the separate `maxOutputTokens` value.

**Architecture:** Keep the change narrowly scoped to the pure model-mapping layer in `src/nanogpt.ts` and its unit tests in `test/nanogpt.test.ts`. The implementation should not alter discovery transport, request execution, or provider lifecycle behavior; it only changes how already-fetched model metadata is interpreted.

**Tech Stack:** TypeScript, Vitest, VS Code extension metadata mapping

---

## File Map

- Modify `src/nanogpt.ts`
  Change the mapper contract so `context_length` / `contextWindow` maps directly to `maxInputTokens`, and update the JSDoc accordingly.
- Modify `test/nanogpt.test.ts`
  Update subtraction-based expectations and add a regression test using live-like payload values for DeepSeek V4 Flash, GLM 5.1, and Kimi K2.6.
- Modify `docs/nanogpt-surface-audit.md`
  Update the documented mapping contract from `context_length - max_output_tokens` to direct `context_length`.
- Modify `CHANGELOG.md`
  Record the metadata mapping correction in `Unreleased`.

### Task 1: Create the branch and write failing mapper tests

**Files:**

- Modify: `test/nanogpt.test.ts`

- [ ] **Step 1: Create and switch to a plain feature branch**

Run:

```bash
git switch -c fix/context-length-means-max-input
```

Expected: branch switches successfully from `main` to `fix/context-length-means-max-input`.

- [ ] **Step 2: Update the existing mapper expectations to the new contract**

Change the current expectations in `test/nanogpt.test.ts` so they assert direct input mapping instead of subtraction.

```ts
test("maps discovered NanoGPT models into VS Code model metadata", () => {
  const models = mapNanoGptModelsToVscode([
    {
      id: "gpt-5.4-mini",
      name: "GPT-5.4 Mini",
      context_length: 200000,
      max_output_tokens: 32768,
      capabilities: { vision: true, tool_calling: true },
    },
  ]);

  expect(models).toEqual([
    expect.objectContaining({
      id: "gpt-5.4-mini",
      maxInputTokens: 200000,
      maxOutputTokens: 32768,
    }),
  ]);
});

test("uses default context window and max output tokens when fields are absent", () => {
  const models = mapNanoGptModelsToVscode([{ id: "bare-model", name: "Bare" }]);
  expect(models[0]!.maxOutputTokens).toBe(32768);
  expect(models[0]!.maxInputTokens).toBe(200000);
});

test("accepts contextWindow and maxTokens as aliases for context_length and max_output_tokens", () => {
  const models = mapNanoGptModelsToVscode([
    {
      id: "alias-model",
      name: "Alias",
      contextWindow: 100000,
      maxTokens: 4096,
      capabilities: {},
    },
  ]);
  expect(models[0]!.maxOutputTokens).toBe(4096);
  expect(models[0]!.maxInputTokens).toBe(100000);
});

test("maxInputTokens follows the reported context window even when maxOutputTokens is larger", () => {
  const models = mapNanoGptModelsToVscode([
    { id: "odd-model", name: "Odd", context_length: 100, max_output_tokens: 200 },
  ]);
  expect(models[0]!.maxInputTokens).toBe(100);
});
```

- [ ] **Step 3: Add a live-like regression test for the observed NanoGPT payload values**

Add a focused regression test that locks in the actual numbers observed from the live discovery endpoints.

```ts
test("maps live-like NanoGPT payload values without subtracting output from input", () => {
  const models = mapNanoGptModelsToVscode([
    {
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      context_length: 1048576,
      max_output_tokens: 384000,
      capabilities: { reasoning: true, tool_calling: true },
    },
    {
      id: "zai-org/glm-5.1",
      name: "GLM 5.1",
      context_length: 200000,
      max_output_tokens: 131072,
      capabilities: { reasoning: true, tool_calling: true },
    },
    {
      id: "moonshotai/kimi-k2.6",
      name: "Kimi K2.6",
      context_length: 256000,
      max_output_tokens: 65536,
      capabilities: { vision: true, tool_calling: true },
    },
  ]);

  expect(models.map((model) => ({
    id: model.id,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
  }))).toEqual([
    {
      id: "deepseek/deepseek-v4-flash",
      maxInputTokens: 1048576,
      maxOutputTokens: 384000,
    },
    {
      id: "zai-org/glm-5.1",
      maxInputTokens: 200000,
      maxOutputTokens: 131072,
    },
    {
      id: "moonshotai/kimi-k2.6",
      maxInputTokens: 256000,
      maxOutputTokens: 65536,
    },
  ]);
});
```

- [ ] **Step 4: Run the mapper test file to verify RED**

Run:

```bash
npm test -- test/nanogpt.test.ts
```

Expected: FAIL because `src/nanogpt.ts` still subtracts output tokens from context length.

### Task 2: Implement the direct input-token mapping in the core mapper

**Files:**

- Modify: `src/nanogpt.ts`
- Test: `test/nanogpt.test.ts`

- [ ] **Step 1: Update the mapper JSDoc to match the corrected contract**

Change the documentation above `mapNanoGptModelsToVscode()` so it no longer describes subtraction.

```ts
/**
 * Maps an array of raw NanoGPT model entries into VS Code-compatible
 * {@link VscodeModelMetadata} objects.
 *
 * - Filters by optional allowlist when provided.
 * - Normalises variant field names (`context_length` / `contextWindow`,
 *   `max_output_tokens` / `maxTokens`).
 * - Treats `context_length` / `contextWindow` as `maxInputTokens` directly.
 * - Maps `vision` → `imageInput`, `tool_calling` → `toolCalling`,
 *   and `parallel_tool_calls` → `internal.parallelToolCalls`.
 */
```

- [ ] **Step 2: Change the mapper implementation to stop subtracting output from input**

Replace the current subtraction logic with direct field mapping.

```ts
const maxOutputTokens = isPositiveNumber(entry.max_output_tokens)
  ? entry.max_output_tokens
  : isPositiveNumber(entry.maxTokens)
    ? entry.maxTokens
    : 32768;
const contextWindow = isPositiveNumber(entry.context_length)
  ? entry.context_length
  : isPositiveNumber(entry.contextWindow)
    ? entry.contextWindow
    : 200000;

return [
  {
    id,
    name: String(entry.displayName ?? entry.name ?? id),
    family,
    version,
    maxInputTokens: contextWindow,
    maxOutputTokens,
    detail: "NanoGPT",
    tooltip: `NanoGPT model ${id}`,
    capabilities: {
      imageInput: Boolean(capabilities.imageInput ?? capabilities.vision ?? entry.vision),
      toolCalling: Boolean(
        capabilities.toolCalling ?? capabilities.tool_calling ?? entry.tool_calling,
      ),
      family,
      tokenizer,
    },
    reasoning,
    internal: {
      parallelToolCalls: Boolean(capabilities.parallel_tool_calls),
    },
    configurationSchema: buildModelConfigurationSchema(),
  },
];
```

- [ ] **Step 3: Run the mapper test file to verify GREEN**

Run:

```bash
npm test -- test/nanogpt.test.ts
```

Expected: PASS. The updated mapper expectations and the new live-like regression test should all pass.

### Task 3: Update docs and changelog for the corrected mapping contract

**Files:**

- Modify: `docs/nanogpt-surface-audit.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update the surface audit mapping note**

Replace the old subtraction statement with the corrected direct-mapping statement.

```md
- Treats `context_length` / `contextWindow` as max input tokens.
- Treats `max_output_tokens` / `maxTokens` as the separate max output token limit.
```

- [ ] **Step 2: Add an Unreleased changelog entry for the metadata fix**

Add a concise note under `## Unreleased`.

```md
- Corrected NanoGPT model metadata mapping: the extension now treats `context_length` as the model's max input token limit and reports `max_output_tokens` separately, instead of subtracting output from input.
```

- [ ] **Step 3: Run typecheck after the mapper change**

Run:

```bash
npm run typecheck
```

Expected: PASS with no TypeScript errors.

### Task 4: Run full verification and inspect scope

**Files:**

- Modify: `src/nanogpt.ts`
- Modify: `test/nanogpt.test.ts`
- Modify: `docs/nanogpt-surface-audit.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS with all Vitest files green.

- [ ] **Step 2: Inspect the final diff for scope control**

Run:

```bash
git diff -- src/nanogpt.ts test/nanogpt.test.ts docs/nanogpt-surface-audit.md CHANGELOG.md
```

Expected: only the mapper logic, mapper tests, and concise docs/changelog updates appear.

- [ ] **Step 3: Optionally re-run the live discovery check for comparison**

Run this only if you want a post-change sanity reference against the live numbers already observed:

```bash
set -a && source ./.env.local && set +a
node --input-type=module <<'EOF'
const key = process.env.NANOGPT_API_KEY;
const res = await fetch('https://nano-gpt.com/api/v1/models?detailed=true', {
  headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
});
const payload = await res.json();
const entries = Array.isArray(payload) ? payload : payload.data;
for (const id of ['deepseek/deepseek-v4-flash', 'zai-org/glm-5.1', 'moonshotai/kimi-k2.6']) {
  const entry = entries.find((item) => item.id === id);
  console.log(JSON.stringify({
    id,
    context_length: entry?.context_length,
    max_output_tokens: entry?.max_output_tokens,
  }, null, 2));
}
EOF
```

Expected: the live numbers remain the same as the evidence used for the remap.

## Self-Review

- Spec coverage: the tasks cover the branch creation, the direct remap in `src/nanogpt.ts`, the failing-first test updates, the live-like regression case, and the docs/changelog corrections.
- Placeholder scan: all tasks contain exact files, code snippets, commands, and expected outcomes.
- Type consistency: the plan uses the existing `mapNanoGptModelsToVscode` function and the existing `maxInputTokens` / `maxOutputTokens` property names consistently throughout.
