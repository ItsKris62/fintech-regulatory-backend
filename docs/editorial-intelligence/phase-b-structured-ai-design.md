# SheriaBot Pack 1 — Phase B: Structured AI Output Layer (Foundation B, detailed design)

Status: design proposal, not implemented.

## Why this is required, not optional

Verified: nothing in `src/lib/ai/gateway/` validates model output against a schema.
`LLMCompletionRequest`/`LLMCompletionResult` (`types.ts:3-28`) carry a free-form
`prompt`/`content: string`. The only JSON-compliance mechanism anywhere in the
codebase is the fixed prompt fragment `aiConfig.systemPrompts.jsonOutput`
(`ai.config.ts:196`). `ai-draft-generation.service.ts` parses its own JSON inline
with no shared validator; `blog-verification.service.ts`'s `useAiReview` flag is a
documented no-op (`blog-verification.service.ts:208-213`) specifically because no
safe way to consume AI output existed when it was stubbed. Editorial triage,
research synthesis, and claim verification all require deterministic, schema-shaped
output that a downstream Pack 1 automation procedure (see
`phase-b-procedure-contracts.md` for exact flat tRPC paths, distinct from the
`agents.automation.editorial.*`-namespaced capability strings) can persist
directly into Prisma columns — an unvalidated string cannot safely do that. This
matches stop condition 13's "a workflow must trust AI output without structured
validation," so this layer is a hard prerequisite, not a nice-to-have.

## Module location and naming

`src/lib/ai/structured/completeStructured.ts`, alongside the existing
`src/lib/ai/gateway/` directory (sibling, not nested inside it, since this is a
consumer of the gateway, not part of it — same relationship
`src/modules/agents/agent-run.service.ts` has to the gateway today via its
`LLMCostGuard` interface at `agent-run.service.ts:76-78`).

## Interface

```ts
import { z } from 'zod';
import type { LLMProviderName } from '@/lib/ai/gateway/types';

export type AIUseCase = 'policy' | 'checklist' | 'query' | 'verification' | 'analysis' | 'default';
// Reuses the exact union already defined inline at LLMCompletionRequest['useCase']
// (types.ts:13) rather than introducing a second, parallel AIUseCase type — Pack 1
// procedures pass one of these five values, same as every existing gateway caller.

export interface StructuredCompletionResult<T> {
  data: T;
  providerUsed: LLMProviderName;
  modelUsed: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  validationAttempts: number; // 1 = succeeded on first try, 2 = required the one correction attempt
  rawResponseHash: string; // sha256 hex of the raw provider response text — for audit correlation, never the text itself
}

export interface CompleteStructuredInput<T> {
  useCase: AIUseCase;
  schema: z.ZodType<T>;
  schemaName: string; // for logging/error messages only, e.g. 'EditorialTriageAssessment'
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  provider?: LLMProviderName;
  model?: string;
  allowFallback?: boolean;
  correctionAttemptLimit?: number; // default 1, max 1 — see "bounded correction" below
  overrideTimeoutMs?: number;
  signal?: AbortSignal;
}

export async function completeStructured<T>(
  input: CompleteStructuredInput<T>,
): Promise<StructuredCompletionResult<T>>;
```

## Behavior

### 1. Prompt construction

`completeStructured` appends a fixed suffix to the caller's `systemPrompt` (never
replaces it — the caller's own system prompt retains authority over domain content,
per the "preserve system prompt authority" security rule below):

```
{caller systemPrompt}

Respond with a single JSON object only. Do not include markdown code fences, prose
before or after the JSON, or explanatory text. The JSON must match this shape:
{zod-to-json-schema summary of `schema`, generated via zod-to-json-schema at call time — not hand-maintained per schema}
```

This reuses the *intent* of `aiConfig.systemPrompts.jsonOutput` but makes it
schema-specific and machine-checkable, rather than the existing fixed generic
string.

### 2. Calling the gateway

Delegates directly to `llmGateway.complete()` (`llm-gateway.ts:158`), passing
`useCase`, `provider`, `model`, `allowFallback`, `maxTokens`, `overrideTimeoutMs`,
`signal` straight through unchanged. **No new retry/timeout/fallback logic is
implemented in this layer** — `LLMGateway` already owns exponential backoff
(`aiConfig.retry`), per-use-case timeouts (`aiConfig.timeout`), and cross-provider
fallback (`llm-gateway.ts:239-253`). `completeStructured`'s only additional retry
concept is the bounded *correction* attempt (§4), which is a distinct, one-shot
"ask the model to fix its own malformed JSON" loop, not a network-failure retry.

### 3. Extraction

```ts
function extractJsonCandidate(rawText: string): string | null {
  // 1. Strip a single leading/trailing fenced code block if present: ```json ... ``` or ``` ... ```
  // 2. If the remaining trimmed text starts with '{' and ends with '}', return it as-is.
  // 3. Otherwise, find the first '{' and the last '}' in the text and return that
  //    substring (handles "Here is the JSON: { ... } Let me know if..." style
  //    prose-wrapped responses some providers produce despite instructions).
  // 4. If no '{'/'}' pair is found, return null.
}
```

- **Maximum response length**: reject (raise `AIStructuredOutputError` with code
  `RESPONSE_TOO_LARGE`) before attempting extraction if `rawText.length` exceeds a
  fixed ceiling (default 200,000 chars ≈ well above any `maxTokens` this layer will
  be called with — Pack 1's largest expected use case, research-pack synthesis,
  targets `aiConfig.parameters` in the low thousands of output tokens). This is a
  defense-in-depth cap, not a normal-path limit.
- Extraction never uses `eval`/`Function` — only string slicing and
  `JSON.parse`.

### 4. Validation and bounded correction

```
attempt 1:
  candidate = extractJsonCandidate(rawText)
  if candidate is null → throw AIStructuredOutputError('NO_JSON_FOUND')
  parsed = try JSON.parse(candidate) → on failure, treat as a validation failure (not a separate code path)
  result = schema.safeParse(parsed)
  if result.success → return { data: result.data, validationAttempts: 1, ... }

if correctionAttemptLimit >= 1 (default 1):
  build a correction prompt:
    "Your previous response could not be parsed as valid JSON matching the
    required schema. Validation errors: {sanitized issue list, capped at 10 items,
    field paths + short messages only — see redaction rule below}.
    Respond again with ONLY the corrected JSON object."
  call llmGateway.complete() again with the ORIGINAL systemPrompt (with schema
    suffix) + the correction prompt as the new user turn (not a chat history —
    this codebase's gateway is single-turn; the correction prompt restates the
    original ask plus the error, since there is no multi-turn conversation state
    to carry forward)
  re-run extraction + validation once

if still failing → throw AIStructuredOutputError('SCHEMA_VALIDATION_FAILED', { attempts: 2 })
```

`correctionAttemptLimit` is capped at 1 in the type (`0 | 1`, not an open `number`)
— the design brief's "one bounded correction attempt" is enforced by the type
system, not just a runtime default, so no future caller can silently request
unbounded retries that would blow past `AgentRunService`'s per-run budget guard.

**Never returns partially validated data**: `schema.safeParse` either fully
succeeds or the function throws — there is no partial/best-effort return path. This
is why the schema must be authored to make every field the caller actually needs
non-optional (Zod `.optional()` fields the caller doesn't handle a missing case for
are a caller-side bug, not something this layer papers over).

### 5. Cost, token, and metadata preservation

`StructuredCompletionResult` carries `providerUsed`/`modelUsed` straight from
`LLMCompletionResult.provider`/`.model`, and `inputTokens`/`outputTokens` from
`.usage`. If a correction attempt occurs, token/cost fields **sum across both
calls** (the correction call is a real, billed second request) — `estimatedCostUsd`
is computed via the existing `calculateCost()` (`pricing.ts`) for each call and
summed, matching how `LLMGateway.trackCost()` already independently records each
call's real cost to the Redis daily-cost key regardless of what this layer reports
back to its caller.

`AgentRun` budget integration is the caller's responsibility, unchanged: a Pack 1
procedure wraps its `completeStructured` call in the same
`agentRunService.beginRun/advanceRun/completeRun/failRun` pattern
`automation.service.ts::generate()` already uses (single-shot variant, §6 of the
Phase A automation-services audit) — `completeStructured` itself does not call
`AgentRunService`, keeping the two layers independently testable.

### 6. Raw-response hashing, not storage

```ts
rawResponseHash: sha256Hex(rawResponseText) // full raw text hashed, never persisted or logged verbatim
```

Only the hash is returned/logged. If an operator needs to inspect a specific
failure's raw output for debugging, that requires a separate, explicitly
opt-in debug capture path (not built in Phase B) — by default, no Pack 1 log line
or DB row contains full model output text, per the "never log full model output"
security rule.

### 7. Structured error classes

```ts
export class AIStructuredOutputError extends Error {
  constructor(
    public readonly code:
      | 'NO_JSON_FOUND'
      | 'RESPONSE_TOO_LARGE'
      | 'SCHEMA_VALIDATION_FAILED'
      | 'CORRECTION_FAILED'
      | 'PROVIDER_TIMEOUT'
      | 'BUDGET_EXHAUSTED'
      | 'UNSUPPORTED_PROVIDER'
      | 'FALLBACK_EXHAUSTED'
      | 'INVALID_SCHEMA_CONFIGURATION',
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AIStructuredOutputError';
  }
}
```

Mapping from underlying gateway errors: `LLMProviderNotConfiguredError` →
`UNSUPPORTED_PROVIDER`; a timed-out `AbortController` (surfaces as a generic
`Error` from `llm-gateway.ts:329-333`'s stream path, or a provider-level timeout on
the non-streaming path) → `PROVIDER_TIMEOUT`; `LLMCostLimitError` →
`BUDGET_EXHAUSTED`; exhausted `req.allowFallback` fallbacks (all configured
providers unconfigured/failing) → `FALLBACK_EXHAUSTED`; a caller-supplied
`schema`/`schemaName` that fails to compile a JSON-schema summary (e.g., a Zod
schema using an unsupported refinement) → `INVALID_SCHEMA_CONFIGURATION`, thrown
before any network call is made.

Every Pack 1 AI-calling procedure (`triageEditorialCandidate`, `createResearchPack`,
`verifyBlogPostClaims`, `runFreshnessReview` — not `createRevisionRequest`, which
never calls `completeStructured`) maps these to tRPC error codes consistently (see `phase-b-procedure-contracts.md`'s per-procedure "Errors"
column): `SCHEMA_VALIDATION_FAILED`/`CORRECTION_FAILED`/`NO_JSON_FOUND` →
`INTERNAL_SERVER_ERROR` (a model/prompt problem, not a caller input problem);
`BUDGET_EXHAUSTED` → `TOO_MANY_REQUESTS` (matches the existing convention in
`blog-draft.service.ts:216-219`); `PROVIDER_TIMEOUT`/`FALLBACK_EXHAUSTED` →
`INTERNAL_SERVER_ERROR`; `UNSUPPORTED_PROVIDER`/`INVALID_SCHEMA_CONFIGURATION` →
programmer errors, should never occur in production, `INTERNAL_SERVER_ERROR`.

## Security rules (mapped to concrete implementation decisions)

| Rule | Implementation |
|---|---|
| Never place source text into error messages | `AIStructuredOutputError.message` is a fixed template string per code; raw prompts/responses only ever appear as `meta.rawResponseHash` or `meta.schemaName`, never as literal content. |
| Never log full model output | Every `logger.info/warn/error` call in this module logs `{ schemaName, useCase, provider, model, validationAttempts, rawResponseHash }` — never `rawText` or `candidate`. |
| Cap validation issue count | The correction prompt includes at most 10 Zod issues (`result.error.issues.slice(0, 10)`), each reduced to `{ path: issue.path.join('.'), message: issue.message }` — no `received`/`expected` raw-value echoes that could round-trip attacker-controlled source text back into a second prompt. |
| Redact URLs or credentials where needed | The correction-prompt issue formatter strips any string matching a URL or the existing W-SHARED-ERR secret-pattern list (reused, not reinvented — see `phase-b-security-review.md`) from issue messages before they're re-sent to the model. |
| Treat source content as untrusted | Any caller passing external source text (research pack synthesis, claim verification) must wrap it in an explicit delimiter block in `userPrompt` (e.g., `<source id="...">...</source>`) — this layer doesn't parse or re-inject source text itself, so the discipline lives in each Pack 1 prompt template, documented as a required convention here. |
| Defend against prompt injection | The schema-suffix instruction ("Respond with a single JSON object only...") is appended to `systemPrompt`, never derived from or concatenated with `userPrompt`/source content — an injected instruction inside source text can at worst corrupt the JSON *content* (caught by schema validation and, for claims, by the verification-policy layer expecting evidence-linked claims) but cannot alter the response-format contract itself. |
| Preserve system prompt authority | The caller's `systemPrompt` is always prepended, in full, before the schema suffix — this layer never overwrites or reorders it. |

## Test strategy (see `phase-b-test-plan.md` for the full matrix; summarized here)

- Fenced-JSON extraction, unfenced JSON extraction, prose-wrapped JSON extraction,
  no-JSON input → all four extraction branches unit-tested independently of any
  network call.
- Zod success path (`validationAttempts: 1`).
- Zod failure → correction → success (`validationAttempts: 2`).
- Zod failure → correction → still fails → `SCHEMA_VALIDATION_FAILED` thrown, and
  the mocked `llmGateway.complete` is asserted to have been called exactly twice
  (never a third, silent retry).
- `RESPONSE_TOO_LARGE` short-circuits before calling `JSON.parse` on a huge string.
- Cost/token summation across a correction round-trip.
- Redaction: a Zod issue message containing a URL/secret-shaped string is asserted
  absent from the correction prompt sent to the mocked gateway.
- `rawResponseHash` is present and is never equal to any literal substring of the
  input prompts (guards against accidentally hashing the wrong buffer).
