import { describe, expect, it } from 'vitest';
import type { AICompletionResult } from './client';
import { mergeGapAnalysisProviderUsage } from './ai.service';

function completion(overrides: Partial<AICompletionResult>): AICompletionResult {
  return {
    content: '{}',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    inputTokens: 100,
    outputTokens: 25,
    cost: 0.001,
    pricingVerified: true,
    ...overrides,
  };
}

describe('Gap Analysis provider and cost telemetry', () => {
  it('aggregates tokens and estimated cost by the provider and model actually used', () => {
    const usage = mergeGapAnalysisProviderUsage([
      completion({ inputTokens: 100, outputTokens: 20, cost: 0.001 }),
      completion({ inputTokens: 150, outputTokens: 30, cost: 0.002 }),
      completion({
        provider: 'openai',
        model: 'gpt-4o-mini',
        inputTokens: 80,
        outputTokens: 10,
        cost: 0.0002,
      }),
    ]);

    expect(usage).toEqual([
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        callCount: 2,
        inputTokens: 250,
        outputTokens: 50,
        costType: 'ESTIMATED',
        estimatedCostUsd: 0.003,
        pricingVersion: '2026.09.v1',
        ratesUsdPerMillion: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        callCount: 1,
        inputTokens: 80,
        outputTokens: 10,
        costType: 'ESTIMATED',
        estimatedCostUsd: 0.0002,
        pricingVersion: '2026.09.v1',
        ratesUsdPerMillion: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
      },
    ]);
  });

  it('does not report a numeric estimate when configured pricing is unavailable', () => {
    const usage = mergeGapAnalysisProviderUsage([
      completion({ model: 'unpriced-model', pricingVerified: false, cost: 99 }),
    ]);

    expect(usage).toEqual([
      {
        provider: 'anthropic',
        model: 'unpriced-model',
        callCount: 1,
        inputTokens: 100,
        outputTokens: 25,
        costType: 'NOT_VERIFIED',
      },
    ]);
  });
});
