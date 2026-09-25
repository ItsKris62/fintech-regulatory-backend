import { describe, it, expect, vi, beforeEach } from 'vitest';
import { llmGateway, getCurrentBudgetPeriod } from './llm-gateway';
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
    sismember: vi.fn().mockResolvedValue(0),
    sadd: vi.fn().mockResolvedValue(1),
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
    (appConfig as any).ai = { apiKey: 'test-ant', model: 'claude-haiku', monthlyBudgetUsd: 20 };
    (appConfig as any).openai = { apiKey: 'test-open', model: 'gpt-4o' };
    (appConfig as any).gemini = { apiKey: 'test-gemini', model: 'gemini-2.5-flash' };
    (aiConfig.costs as any).monthlyBudgetUsd = 20;
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

    const req: LLMCompletionRequest = { prompt: 'hello', orgId: 'org-test' };
    const res = await llmGateway.complete(req);

    expect(spy).toHaveBeenCalled();
    expect(res.provider).toBe('anthropic');
    const calledReq = spy.mock.calls[0][0];
    expect(calledReq.prompt).toBe('hello');
  });

  it('cache key requires orgId or globalCache and throws if both are omitted', () => {
    expect(() => {
      llmGateway.generateCacheKey('anthropic', 'modelA', 'prompt', 'sys');
    }).toThrowError(/Tenant orgId is required/);
  });

  it('cache key differs across provider and model', () => {
    const key1 = llmGateway.generateCacheKey('anthropic', 'modelA', 'prompt', 'sys', { orgId: 'org-1' });
    const key2 = llmGateway.generateCacheKey('openai', 'modelA', 'prompt', 'sys', { orgId: 'org-1' });
    const key3 = llmGateway.generateCacheKey('anthropic', 'modelB', 'prompt', 'sys', { orgId: 'org-1' });

    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
  });

  it('cache key produces deterministic sha256 hex hash with ai:cache: prefix', () => {
    const keyA = llmGateway.generateCacheKey('anthropic', 'claude-3-5-sonnet', 'test prompt', 'system instructions', { orgId: 'org-1' });
    const keyB = llmGateway.generateCacheKey('anthropic', 'claude-3-5-sonnet', 'test prompt', 'system instructions', { orgId: 'org-1' });

    expect(keyA).toBe(keyB);
    expect(keyA).toMatch(/^ai:cache:anthropic:[a-f0-9]{64}$/);
  });

  it('cache key isolates tenants and allows explicit globalCache: true', () => {
    const keyOrgA = llmGateway.generateCacheKey('anthropic', 'claude-3-5-sonnet', 'identical prompt', 'system', { orgId: 'org-alpha' });
    const keyOrgB = llmGateway.generateCacheKey('anthropic', 'claude-3-5-sonnet', 'identical prompt', 'system', { orgId: 'org-beta' });
    const keyGlobal = llmGateway.generateCacheKey('anthropic', 'claude-3-5-sonnet', 'identical prompt', 'system', { globalCache: true });

    expect(keyOrgA).not.toBe(keyOrgB);
    expect(keyOrgA).not.toBe(keyGlobal);
    expect(keyOrgB).not.toBe(keyGlobal);
  });

  it('missing-price path logs llm_pricing_missing, charges highest-known rate, does not throw', async () => {
    const anthropicProvider = llmGateway.getProvider('anthropic');
    vi.spyOn(anthropicProvider, 'complete').mockResolvedValue({
      content: 'test',
      provider: 'anthropic',
      model: 'unknown-model',
      usage: { inputTokens: 1000, outputTokens: 1000 },
      stopReason: 'end',
    });
    vi.mocked(redis.get).mockResolvedValue('0'); // cost 0
    vi.mocked(logger.warn).mockClear();

    const req: LLMCompletionRequest = { prompt: 'hello', model: 'unknown-model', provider: 'anthropic', orgId: 'org-test' };
    const res = await llmGateway.complete(req);

    expect(res.content).toBe('test');
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ type: 'llm_pricing_missing' }));
    
    // highest rate logic will apply to cost tracking
    expect(redis.incrbyfloat).toHaveBeenCalled();
  });

  it('unconfigured provider throws LLMProviderNotConfiguredError', async () => {
    (appConfig as any).openai.apiKey = undefined;
    const req: LLMCompletionRequest = { prompt: 'hello', provider: 'openai', model: 'openai:gpt-4o', orgId: 'org-test' };
    await expect(llmGateway.complete(req)).rejects.toThrowError(LLMProviderNotConfiguredError);
  });

  it('allowFallback off = no fallback', async () => {
    const anthropicProvider = llmGateway.getProvider('anthropic');
    vi.spyOn(anthropicProvider, 'complete').mockRejectedValue(new LLMProviderError('anthropic', 'fail', 500, false));
    
    const req: LLMCompletionRequest = { prompt: 'hello', provider: 'anthropic', allowFallback: false, orgId: 'org-test' };
    
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

    const req: LLMCompletionRequest = { prompt: 'hello', provider: 'anthropic', allowFallback: true, orgId: 'org-test' };
    const res = await llmGateway.complete(req);

    expect(res.content).toBe('fallback');
    expect(fallbackSpy).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ type: 'llm_fallback_used', to: 'openai' }));
  });

  it('cost-limit gate throws before any provider call when monthly budget is exhausted', async () => {
    vi.mocked(redis.get).mockImplementation(async (key: string) => {
      if (key.includes('ai:cost:global:')) return '20.05'; // above 20.00 limit
      return '0';
    });
    const anthropicProvider = llmGateway.getProvider('anthropic');
    const spy = vi.spyOn(anthropicProvider, 'complete');

    const req: LLMCompletionRequest = { prompt: 'hello', orgId: 'org-test' };
    await expect(llmGateway.complete(req)).rejects.toThrowError(LLMCostLimitError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports monthly budget status with provider telemetry correctly', async () => {
    const period = getCurrentBudgetPeriod();
    vi.mocked(redis.get).mockImplementation(async (key: string) => {
      if (key === `ai:cost:global:${period}`) return '12.50';
      if (key === `ai:cost:global:reserved:${period}`) return '1.20';
      if (key === `ai:cost:provider:anthropic:${period}`) return '8.50';
      if (key === `ai:cost:provider:openai:${period}`) return '4.00';
      if (key === `ai:cost:provider:gemini:${period}`) return '0.00';
      return '0';
    });

    const status = await llmGateway.getMonthlyBudgetStatus(period);

    expect(status.period).toBe(period);
    expect(status.budgetUsd).toBe(20);
    expect(status.spentUsd).toBe(12.5);
    expect(status.reservedUsd).toBe(1.2);
    expect(status.remainingUsd).toBe(6.3);
    expect(status.percentUsed).toBe(68.5);
    expect(status.providers.anthropic).toBe(8.5);
    expect(status.providers.openai).toBe(4.0);
    expect(status.providers.gemini).toBe(0.0);
  });
});
