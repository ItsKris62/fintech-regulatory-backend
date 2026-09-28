import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateCost } from './pricing';
import { logger } from '@/utils/logger';

vi.mock('@/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Pricing Unit Tests with Provider Prompt Caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calculates standard non-cached cost correctly for Anthropic Claude Sonnet', () => {
    // Sonnet 4.6: $3 / 1M input, $15 / 1M output
    const { cost, isMissing } = calculateCost('anthropic', 'claude-sonnet-4-6', 1_000_000, 1_000_000);
    expect(isMissing).toBe(false);
    expect(cost).toBeCloseTo(18.0, 4); // 3 + 15
  });

  it('calculates Anthropic discounted cache read and premium cache write correctly', () => {
    // Sonnet 4.6: $3 input, $15 output, cacheWrite: $3.75 (1.25x), cacheRead: $0.30 (0.10x)
    // 500k uncached input = $1.50
    // 1M cache write = $3.75
    // 2M cache read = $0.60
    // 100k output = $1.50
    // Total = 1.50 + 3.75 + 0.60 + 1.50 = $7.35
    const { cost, isMissing } = calculateCost('anthropic', 'claude-sonnet-4-6', 500_000, 100_000, {
      cacheWriteTokens: 1_000_000,
      cacheReadTokens: 2_000_000,
    });
    expect(isMissing).toBe(false);
    expect(cost).toBeCloseTo(7.35, 4);
  });

  it('calculates OpenAI cached prompt tokens at 50% discount', () => {
    // GPT-4o: $5 input, $15 output, cacheRead: $2.50
    // 1M total prompt tokens with 600k cached tokens -> 400k uncached ($2.00) + 600k cached ($1.50) + 100k output ($1.50) = $5.00
    const { cost, isMissing } = calculateCost('openai', 'gpt-4o', 1_000_000, 100_000, {
      cacheReadTokens: 600_000,
    });
    expect(isMissing).toBe(false);
    expect(cost).toBeCloseTo(5.00, 4);
  });

  it('calculates Gemini cached prompt tokens at 75% discount', () => {
    // Gemini 1.5 Pro: $3.50 input, $10.50 output, cacheRead: $0.875
    // 1M total prompt tokens with 800k cached -> 200k uncached ($0.70) + 800k cached ($0.70) = $1.40 input
    const { cost, isMissing } = calculateCost('gemini', 'gemini-1.5-pro', 1_000_000, 0, {
      cacheReadTokens: 800_000,
    });
    expect(isMissing).toBe(false);
    expect(cost).toBeCloseTo(1.40, 4);
  });

  it('falls back to conservative max rate and logs warning once for unknown model', () => {
    const res1 = calculateCost('anthropic', 'unknown-exotic-model', 1_000_000, 1_000_000);
    expect(res1.isMissing).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Second call for same unknown model does not duplicate warning log
    const res2 = calculateCost('anthropic', 'unknown-exotic-model', 500_000, 500_000);
    expect(res2.isMissing).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
