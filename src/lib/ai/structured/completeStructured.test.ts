import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { completeStructured } from './completeStructured';
import { AIStructuredOutputError } from './errors';
import { LLMCostLimitError, LLMProviderNotConfiguredError, type LLMCompletionRequest, type LLMCompletionResult } from '../gateway/types';

type CompleteFn = (req: LLMCompletionRequest, cacheTTL?: number) => Promise<LLMCompletionResult>;

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const TestSchema = z.object({
  score: z.number(),
  label: z.string(),
});

function completionResult(overrides: Partial<LLMCompletionResult> = {}): LLMCompletionResult {
  return {
    content: JSON.stringify({ score: 42, label: 'ok' }),
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    usage: { inputTokens: 100, outputTokens: 50 },
    stopReason: 'end',
    ...overrides,
  };
}

function baseInput(overrides: Partial<Parameters<typeof completeStructured>[0]> = {}) {
  return {
    useCase: 'query' as const,
    schema: TestSchema,
    schemaName: 'TestSchema',
    systemPrompt: 'You are a helpful assistant.',
    userPrompt: 'Score this item.',
    ...overrides,
  };
}

describe('completeStructured', () => {
  let complete: ReturnType<typeof vi.fn<CompleteFn>>;

  beforeEach(() => {
    complete = vi.fn<CompleteFn>();
  });

  it('returns validated data on first attempt (validationAttempts: 1)', async () => {
    complete.mockResolvedValueOnce(completionResult());

    const result = await completeStructured(baseInput(), { llmGateway: { complete } });

    expect(result.data).toEqual({ score: 42, label: 'ok' });
    expect(result.validationAttempts).toBe(1);
    expect(result.providerUsed).toBe('anthropic');
    expect(result.modelUsed).toBe('claude-opus-4-6');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('extracts JSON from a fenced code block on first attempt', async () => {
    complete.mockResolvedValueOnce(completionResult({ content: '```json\n{"score": 7, "label": "fenced"}\n```' }));

    const result = await completeStructured(baseInput(), { llmGateway: { complete } });

    expect(result.data).toEqual({ score: 7, label: 'fenced' });
    expect(result.validationAttempts).toBe(1);
  });

  it('recovers via one correction attempt when the first response fails validation (validationAttempts: 2)', async () => {
    complete
      .mockResolvedValueOnce(completionResult({ content: '{"score": "not-a-number", "label": "bad"}' }))
      .mockResolvedValueOnce(completionResult({ content: '{"score": 9, "label": "fixed"}' }));

    const result = await completeStructured(baseInput(), { llmGateway: { complete } });

    expect(result.data).toEqual({ score: 9, label: 'fixed' });
    expect(result.validationAttempts).toBe(2);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('throws SCHEMA_VALIDATION_FAILED after the correction attempt also fails, calling the gateway exactly twice', async () => {
    complete
      .mockResolvedValueOnce(completionResult({ content: '{"score": "bad"}' }))
      .mockResolvedValueOnce(completionResult({ content: '{"score": "still-bad"}' }));

    await expect(completeStructured(baseInput(), { llmGateway: { complete } })).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('throws NO_JSON_FOUND when the response contains no JSON object', async () => {
    complete.mockResolvedValueOnce(completionResult({ content: 'I cannot help with that.' }));

    await expect(completeStructured(baseInput(), { llmGateway: { complete } })).rejects.toMatchObject({
      code: 'NO_JSON_FOUND',
    });
  });

  it('throws RESPONSE_TOO_LARGE before attempting to parse an oversized response', async () => {
    const huge = 'x'.repeat(200_001);
    complete.mockResolvedValueOnce(completionResult({ content: huge }));

    await expect(completeStructured(baseInput(), { llmGateway: { complete } })).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    });
    // Only the first call should have happened — an oversized response is not
    // eligible for a correction retry.
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('does not attempt a correction when correctionAttemptLimit is 0', async () => {
    complete.mockResolvedValueOnce(completionResult({ content: '{"score": "bad"}' }));

    await expect(
      completeStructured(baseInput({ correctionAttemptLimit: 0 }), { llmGateway: { complete } }),
    ).rejects.toMatchObject({ code: 'SCHEMA_VALIDATION_FAILED' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('redacts URL and secret-shaped strings out of the correction prompt', async () => {
    complete
      .mockImplementationOnce(async () => completionResult({ content: '{"score": "bad"}' }))
      .mockImplementationOnce(async (req: { prompt: string }) => {
        // The Zod issue message itself won't contain a URL/secret, so inject one
        // via a schema whose refinement message does, to exercise redaction.
        expect(req.prompt).not.toMatch(/https?:\/\//);
        expect(req.prompt).not.toMatch(/sb_agent_/);
        return completionResult({ content: '{"score": 1, "label": "ok"}' });
      });

    const SchemaWithUrlInMessage = z.object({
      score: z.number({ message: 'must be a number, see https://example.com/docs and sb_agent_deadbeefdeadbeef' }),
      label: z.string(),
    });

    await completeStructured(
      baseInput({ schema: SchemaWithUrlInMessage, schemaName: 'SchemaWithUrlInMessage' }),
      { llmGateway: { complete } },
    );

    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('sums input/output tokens and cost across a correction round-trip', async () => {
    complete
      .mockResolvedValueOnce(completionResult({ content: '{"score": "bad"}', usage: { inputTokens: 100, outputTokens: 20 } }))
      .mockResolvedValueOnce(completionResult({ content: '{"score": 1, "label": "ok"}', usage: { inputTokens: 150, outputTokens: 30 } }));

    const result = await completeStructured(baseInput(), { llmGateway: { complete } });

    expect(result.inputTokens).toBe(250);
    expect(result.outputTokens).toBe(50);
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('returns a rawResponseHash that is not a literal substring of the prompts or response', async () => {
    const content = '{"score": 1, "label": "ok"}';
    complete.mockResolvedValueOnce(completionResult({ content }));

    const result = await completeStructured(baseInput(), { llmGateway: { complete } });

    expect(result.rawResponseHash).toMatch(/^[a-f0-9]{64}$/);
    expect(content).not.toContain(result.rawResponseHash);
  });

  it('never returns partially validated data', async () => {
    complete
      .mockResolvedValueOnce(completionResult({ content: '{"score": "bad"}' }))
      .mockResolvedValueOnce(completionResult({ content: '{"score": "still-bad"}' }));

    try {
      await completeStructured(baseInput(), { llmGateway: { complete } });
      expect.fail('expected completeStructured to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AIStructuredOutputError);
      expect((error as AIStructuredOutputError).meta).not.toHaveProperty('data');
    }
  });

  it('maps LLMProviderNotConfiguredError to UNSUPPORTED_PROVIDER', async () => {
    complete.mockRejectedValueOnce(new LLMProviderNotConfiguredError('openai'));

    await expect(completeStructured(baseInput(), { llmGateway: { complete } })).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROVIDER',
    });
  });

  it('maps LLMCostLimitError to BUDGET_EXHAUSTED', async () => {
    complete.mockRejectedValueOnce(new LLMCostLimitError('Daily AI cost limit exceeded'));

    await expect(completeStructured(baseInput(), { llmGateway: { complete } })).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
    });
  });

  it('maps an abort/timeout-shaped gateway error to PROVIDER_TIMEOUT', async () => {
    complete.mockRejectedValueOnce(new Error('LLM stream exceeded overall timeout of 60000ms'));

    await expect(completeStructured(baseInput(), { llmGateway: { complete } })).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
  });

  it('rejects an invalid schema configuration before calling the gateway', async () => {
    // z.custom with a validator that z.toJSONSchema cannot represent throws
    // during JSON Schema conversion in zod v4's strict mode.
    const uncastableSchema = z.custom<() => void>((val) => typeof val === 'function');

    await expect(
      completeStructured(baseInput({ schema: uncastableSchema as never, schemaName: 'Uncastable' }), {
        llmGateway: { complete },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCHEMA_CONFIGURATION' });
    expect(complete).not.toHaveBeenCalled();
  });
});
