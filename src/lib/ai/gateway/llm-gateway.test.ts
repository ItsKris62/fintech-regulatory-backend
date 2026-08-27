import { describe, it, expect, vi, beforeEach } from 'vitest';
import { llmGateway } from './llm-gateway';
import { LLMProviderNotConfiguredError, LLMCostLimitError, LLMProviderError, LLMCompletionRequest } from './types';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { appConfig } from '@/config/app.config';
import { aiConfig } from '@/config/ai.config';

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    incrbyfloat: vi.fn(),
    expire: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  logPerformance: vi.fn(),
}));

vi.mock('../rate-limiter', () => ({
  aiRateLimiter: {
    acquire: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  }
}));

describe('LLMGateway Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(redis.get).mockReset().mockResolvedValue(null);
    vi.mocked(redis.set).mockReset().mockResolvedValue('OK' as never);
    vi.mocked(redis.incrbyfloat).mockReset().mockResolvedValue(0 as never);
    vi.mocked(redis.expire).mockReset().mockResolvedValue(1 as never);
    vi.mocked(redis.del).mockReset().mockResolvedValue(1 as never);
    (appConfig as any).ai = { apiKey: 'test-ant', model: 'claude-haiku' };
    (appConfig as any).openai = { apiKey: 'test-open', model: 'gpt-4o' };
    (appConfig as any).gemini = { apiKey: 'test-gemini', model: 'gemini-2.5-flash' };
    (aiConfig.costs as any).dailyLimit = 500;
  });

  it('default routing selects Anthropic and preserves request shape', async () => {
    const anthropicProvider = llmGateway.getProvider('anthropic');
    const spy = vi.spyOn(anthropicProvider, 'complete').mockResolvedValue({
      content: 'test',
      provider: 'anthropic',
      model: 'claude-haiku',
      usage: { inputTokens: 10, outputTokens: 10 },
      stopReason: 'end',
    });
    vi.mocked(redis.get).mockResolvedValue(null);

    const req: LLMCompletionRequest = { prompt: 'hello' };
    const res = await llmGateway.complete(req);

    expect(spy).toHaveBeenCalled();
    expect(res.provider).toBe('anthropic');
    const calledReq = spy.mock.calls[0][0];
    expect(calledReq.prompt).toBe('hello');
    expect(calledReq.model).toBe('claude-sonnet-5'); // runtime query default applied
  });

  it('cache key differs across provider and model', () => {
    const key1 = llmGateway.generateCacheKey('anthropic', 'modelA', 'prompt', 'sys');
    const key2 = llmGateway.generateCacheKey('openai', 'modelA', 'prompt', 'sys');
    const key3 = llmGateway.generateCacheKey('anthropic', 'modelB', 'prompt', 'sys');

    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
  });

  it('missing-price path logs llm_pricing_missing, charges highest-known rate, does not throw', async () => {
    const anthropicProvider = llmGateway.getProvider('anthropic');
    vi.spyOn(anthropicProvider, 'complete').mockResolvedValue({
      content: 'test',
      provider: 'anthropic',
      model: 'unknown-model',
      usage: { inputTokens: 1000000, outputTokens: 1000000 },
      stopReason: 'end',
    });
    vi.mocked(redis.get).mockResolvedValue('0'); // cost 0
    vi.mocked(logger.warn).mockClear();

    const req: LLMCompletionRequest = { prompt: 'hello', model: 'unknown-model', provider: 'anthropic' };
    const res = await llmGateway.complete(req);

    expect(res.content).toBe('test');
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ type: 'llm_pricing_missing' }));
    
    // highest rate logic will apply to cost tracking
    expect(redis.incrbyfloat).toHaveBeenCalled();
    const chargedAmt = vi.mocked(redis.incrbyfloat).mock.calls[0][1];
    expect(Number(chargedAmt)).toBeGreaterThan(75);
  });

  it('unconfigured provider throws LLMProviderNotConfiguredError', async () => {
    (appConfig as any).openai.apiKey = undefined;
    const req: LLMCompletionRequest = { prompt: 'hello', provider: 'openai', model: 'openai:gpt-4o' };
    await expect(llmGateway.complete(req)).rejects.toThrowError(LLMProviderNotConfiguredError);
  });

  it('allowFallback off = no fallback', async () => {
    const anthropicProvider = llmGateway.getProvider('anthropic');
    vi.spyOn(anthropicProvider, 'complete').mockRejectedValue(new LLMProviderError('anthropic', 'fail', 500, false));
    
    const req: LLMCompletionRequest = { prompt: 'hello', provider: 'anthropic', allowFallback: false };
    
    await expect(llmGateway.complete(req)).rejects.toThrowError('fail');
  });

  it('allowFallback on = one logged fallback', async () => {
    const anthropicProvider = llmGateway.getProvider('anthropic');
    vi.spyOn(anthropicProvider, 'complete').mockRejectedValue(new LLMProviderError('anthropic', 'fail', 500, false));
    
    const openaiProvider = llmGateway.getProvider('openai');
    const fallbackSpy = vi.spyOn(openaiProvider, 'complete').mockResolvedValue({
      content: 'fallback',
      provider: 'openai',
      model: 'gpt-4o',
      usage: { inputTokens: 10, outputTokens: 10 },
      stopReason: 'end',
    });

    vi.mocked(logger.warn).mockClear();

    const req: LLMCompletionRequest = { prompt: 'hello', provider: 'anthropic', allowFallback: true };
    const res = await llmGateway.complete(req);

    expect(res.content).toBe('fallback');
    expect(fallbackSpy).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ type: 'llm_fallback_used', to: 'openai' }));
  });

  it('cost-limit gate throws before any provider call', async () => {
    vi.mocked(redis.get).mockResolvedValue('501'); // above limit
    const anthropicProvider = llmGateway.getProvider('anthropic');
    const spy = vi.spyOn(anthropicProvider, 'complete');

    const req: LLMCompletionRequest = { prompt: 'hello' };
    await expect(llmGateway.complete(req)).rejects.toThrowError(LLMCostLimitError);
    expect(spy).not.toHaveBeenCalled();
  });
});
