import { logger, logPerformance } from '@/utils/logger';
import { redis } from '@/lib/redis/client';
import { getSystemConfigNumber, getRuntimeAIConfig } from '@/lib/system-config';
import { aiConfig, getRetryDelay } from '@/config/ai.config';
import { appConfig } from '@/config/app.config';
import { aiRateLimiter } from '../rate-limiter';
import { calculateCost } from './pricing';
import { 
  ILLMProvider, 
  LLMCompletionRequest, 
  LLMCompletionResult, 
  LLMStreamOptions, 
  LLMProviderName, 
  LLMCostLimitError, 
  LLMProviderNotConfiguredError 
} from './types';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenAIProvider } from './providers/openai.provider';
import { GeminiProvider } from './providers/gemini.provider';

export class LLMGateway {
  private providers: Map<LLMProviderName, ILLMProvider> = new Map();

  constructor() {
    this.registerProvider(new AnthropicProvider());
    this.registerProvider(new OpenAIProvider());
    this.registerProvider(new GeminiProvider());
  }

  private registerProvider(provider: ILLMProvider) {
    this.providers.set(provider.name, provider);
  }

  getProvider(name: LLMProviderName): ILLMProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Unknown provider: ${name}`);
    }
    if (!provider.isConfigured()) {
      throw new LLMProviderNotConfiguredError(name);
    }
    return provider;
  }

  async getTodayAICost(): Promise<number> {
    try {
      const today = new Date().toISOString().split('T')[0];
      const key = `ai:cost:${today}`;
      const cost = await redis.get<string>(key);
      return parseFloat(cost || '0');
    } catch (error) {
      return 0;
    }
  }

  async resetDailyCost(): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0];
      const key = `ai:cost:${today}`;
      await redis.del(key);
      logger.warn({ type: 'ai_daily_cost_reset', date: today });
    } catch (error: any) {
      logger.error({ type: 'ai_cost_reset_error', error: error.message });
    }
  }

  async getAIStats(): Promise<{ todayCost: number; dailyLimit: number; remainingBudget: number; percentUsed: number; }> {
    const todayCost = await this.getTodayAICost();
    const dailyLimit = await getSystemConfigNumber('aiDailyCostLimit', aiConfig.costs.dailyLimit);
    const remainingBudget = Math.max(0, dailyLimit - todayCost);
    const percentUsed = (todayCost / dailyLimit) * 100;
    return { todayCost, dailyLimit, remainingBudget, percentUsed };
  }

  async trackCost(cost: number): Promise<void> {
    try {
      if (cost <= 0) return;
      const today = new Date().toISOString().split('T')[0];
      const key = `ai:cost:${today}`;
      
      await redis.incrbyfloat(key, cost);
      await redis.expire(key, 86400 * 7);

      const totalCost = parseFloat(await redis.get<string>(key) || '0');
      const limit = await getSystemConfigNumber('aiDailyCostLimit', aiConfig.costs.dailyLimit);

      if (totalCost > limit) {
        logger.error({ type: 'ai_daily_limit_exceeded', totalCost, limit, percentUsed: Math.round((totalCost / limit) * 100) });
      } else if (totalCost > limit * 0.8) {
        logger.warn({ type: 'ai_daily_cost_warning', totalCost, limit, percentUsed: Math.round((totalCost / limit) * 100) });
      }
    } catch (error: any) {
      logger.error({ type: 'ai_cost_tracking_error', error: error.message });
    }
  }

  async checkCostLimit(estimatedCost: number): Promise<void> {
    const todayCost = await this.getTodayAICost();
    const limit = await getSystemConfigNumber('aiDailyCostLimit', aiConfig.costs.dailyLimit);
    const projected = todayCost + estimatedCost;

    if (projected > limit) {
      logger.error({ type: 'ai_daily_limit_blocked', todayCost, estimatedCost, projected, limit, percentUsed: Math.round((projected / limit) * 100) });
      throw new LLMCostLimitError(`Daily AI cost limit of $${limit} exceeded ($${todayCost.toFixed(4)} used today). Requests are blocked until tomorrow or until an admin resets the limit.`);
    }

    if (projected > limit * 0.8) {
      logger.warn({ type: 'ai_daily_cost_warning', todayCost, estimatedCost, projected, limit, percentUsed: Math.round((projected / limit) * 100) });
    }
  }

  generateCacheKey(provider: LLMProviderName, model: string, prompt: string, systemPrompt: string = ''): string {
    const content = `${systemPrompt}|${prompt}|${model}`;
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `ai:cache:${provider}:${Math.abs(hash).toString(36)}`;
  }

  async getCachedCompletion(cacheKey: string): Promise<LLMCompletionResult | null> {
    try {
      const cached = await redis.get<LLMCompletionResult>(cacheKey);
      if (cached) {
        cached.cached = true;
        logger.info({ type: 'ai_cache_hit', cacheKey });
        return cached;
      }
      return null;
    } catch (error: unknown) {
      logger.warn({ type: 'ai_cache_get_error', cacheKey, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  async cacheCompletion(cacheKey: string, result: LLMCompletionResult, ttl: number): Promise<void> {
    try {
      await redis.set(cacheKey, result, { ex: ttl });
      logger.info({ type: 'ai_cache_set', cacheKey, ttl });
    } catch (error: unknown) {
      logger.warn({ type: 'ai_cache_set_error', cacheKey, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private resolveProviderAndModel(req: LLMCompletionRequest, resolvedAIConfig: any): { provider: LLMProviderName, model: string } {
    const providerName = req.provider || 'anthropic';
    let model = req.model || resolvedAIConfig.model;
    if (!model) {
      if (providerName === 'openai') model = appConfig.openai.model;
      else if (providerName === 'gemini') model = appConfig.gemini.model;
      else model = appConfig.ai.model;
    }
    return { provider: providerName, model };
  }

  async complete(req: LLMCompletionRequest, cacheTTL: number = 0): Promise<LLMCompletionResult> {
    const startTime = Date.now();
    const effectiveUseCase = req.useCase === 'default' || !req.useCase ? 'query' : req.useCase;
    const resolvedAIConfig = await getRuntimeAIConfig(effectiveUseCase as any);
    const { provider: providerName, model } = this.resolveProviderAndModel(req, resolvedAIConfig);
    const provider = this.getProvider(providerName);
    
    req.model = model;
    req.temperature = req.temperature ?? resolvedAIConfig.temperature;
    req.maxTokens = req.maxTokens ?? aiConfig.parameters.queryMaxTokens;

    if (cacheTTL > 0) {
      const cacheKey = this.generateCacheKey(providerName, model, req.prompt, req.systemPrompt);
      const cached = await this.getCachedCompletion(cacheKey);
      if (cached) {
        logPerformance('ai_completion_cached', startTime, { provider: providerName, model, useCase: req.useCase });
        return cached;
      }
    }

    const estimatedInputTokens = Math.ceil((req.prompt.length + (req.systemPrompt?.length || 0)) / 4);
    const { cost: estimatedCost, isMissing } = calculateCost(providerName, model, estimatedInputTokens, req.maxTokens!);
    if (isMissing) {
      logger.warn({ type: 'llm_pricing_missing', provider: providerName, model });
    }
    await this.checkCostLimit(estimatedCost);

    let lastError: Error | null = null;
    await aiRateLimiter.acquire();

    try {
      for (let attempt = 1; attempt <= aiConfig.retry.maxAttempts; attempt++) {
        try {
          logger.info({ type: 'llm_completion_attempt', attempt, provider: providerName, model, useCase: req.useCase, promptLength: req.prompt.length });
          
          let timeoutMs = req.overrideTimeoutMs;
          if (!timeoutMs) {
             timeoutMs = req.useCase === 'policy' ? aiConfig.timeout.policyGeneration :
                         req.useCase === 'checklist' ? aiConfig.timeout.checklistGeneration :
                         aiConfig.timeout.default;
          }
          req.overrideTimeoutMs = timeoutMs;
          
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
          
          if (req.signal) {
             if (req.signal.aborted) { clearTimeout(timeoutId); controller.abort(); }
             else req.signal.addEventListener('abort', () => { clearTimeout(timeoutId); controller.abort(); }, { once: true });
          }
          
          const reqWithSignal = { ...req, signal: controller.signal };

          const result = await provider.complete(reqWithSignal);
          clearTimeout(timeoutId);

          const { cost } = calculateCost(providerName, model, result.usage.inputTokens, result.usage.outputTokens);
          await this.trackCost(cost);

          if (cacheTTL > 0) {
            const cacheKey = this.generateCacheKey(providerName, model, req.prompt, req.systemPrompt);
            await this.cacheCompletion(cacheKey, result, cacheTTL);
          }

          logPerformance('llm_completion_success', startTime, { provider: providerName, model, useCase: req.useCase, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cost, attempt });
          return result;

        } catch (error: any) {
          lastError = error;
          const isRetryable = error.retryable || false;
          
          logger.warn({ type: 'llm_completion_error', attempt, provider: providerName, model, error: error.message, status: error.status, retryable: isRetryable });

          if (!isRetryable || attempt === aiConfig.retry.maxAttempts) {
            break;
          }
          const delay = getRetryDelay(attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      
      if (req.allowFallback && lastError) {
         const fallbacks: LLMProviderName[] = ['openai', 'anthropic', 'gemini'];
         for (const fb of fallbacks) {
            if (fb !== providerName) {
               try {
                  this.getProvider(fb); // ensures it is configured
                  logger.warn({ type: 'llm_fallback_used', from: providerName, to: fb, originalError: lastError.message });
                  const reqFallback = { ...req, provider: fb, model: undefined, allowFallback: false };
                  return await this.complete(reqFallback, cacheTTL);
               } catch (e) {
                 // Ignore unconfigured
               }
            }
         }
      }

      logPerformance('llm_completion_failed', startTime, { provider: providerName, model, useCase: req.useCase });
      throw lastError;

    } finally {
      aiRateLimiter.release();
    }
  }

  async stream(opts: LLMStreamOptions): Promise<LLMCompletionResult> {
    const startTime = Date.now();
    const effectiveUseCase = opts.useCase === 'default' || !opts.useCase ? 'query' : opts.useCase;
    const resolvedAIConfig = await getRuntimeAIConfig(effectiveUseCase as any);
    const { provider: providerName, model } = this.resolveProviderAndModel(opts, resolvedAIConfig);
    const provider = this.getProvider(providerName);
    
    opts.model = model;
    opts.temperature = opts.temperature ?? resolvedAIConfig.temperature;
    opts.maxTokens = opts.maxTokens ?? aiConfig.parameters.queryMaxTokens;

    const estimatedInputTokens = Math.ceil((opts.prompt.length + (opts.systemPrompt?.length || 0)) / 4);
    const { cost: estimatedCost, isMissing } = calculateCost(providerName, model, estimatedInputTokens, opts.maxTokens!);
    if (isMissing) logger.warn({ type: 'llm_pricing_missing', provider: providerName, model });
    await this.checkCostLimit(estimatedCost);

    await aiRateLimiter.acquire();
    try {
      logger.info({ type: 'llm_streaming_started', provider: providerName, model, useCase: opts.useCase, promptLength: opts.prompt.length });

      let overallTimeoutMs = opts.overrideTimeoutMs ?? (
        opts.useCase === 'policy' ? aiConfig.timeout.policyGeneration :
        opts.useCase === 'checklist' ? aiConfig.timeout.checklistGeneration :
        aiConfig.timeout.default
      );
      const chunkTimeoutMs = aiConfig.timeout.streamingChunk;

      const controller = new AbortController();
      let abortReason = `LLM stream exceeded overall timeout of ${overallTimeoutMs}ms`;
      const overallTimeoutId = setTimeout(() => controller.abort(), overallTimeoutMs);

      if (opts.externalAbortSignal) {
        if (opts.externalAbortSignal.aborted) {
          clearTimeout(overallTimeoutId);
          controller.abort();
        } else {
          opts.externalAbortSignal.addEventListener('abort', () => {
            abortReason = 'Client disconnected - stream aborted';
            clearTimeout(overallTimeoutId);
            controller.abort();
          }, { once: true });
        }
      }
      
      const streamOptsWithSignal = { ...opts, signal: controller.signal };
      let result: LLMCompletionResult;
      
      try {
         let chunkTimeoutId: ReturnType<typeof setTimeout> | null = null;
         const resetChunkTimeout = () => {
            if (chunkTimeoutId !== null) clearTimeout(chunkTimeoutId);
            chunkTimeoutId = setTimeout(() => {
               abortReason = `LLM stream hung  -  no data received for ${chunkTimeoutMs}ms`;
               controller.abort();
            }, chunkTimeoutMs);
         };
         resetChunkTimeout();
         
         const origOnChunk = streamOptsWithSignal.onChunk;
         streamOptsWithSignal.onChunk = (chunk) => {
            resetChunkTimeout();
            if (origOnChunk) origOnChunk(chunk);
         };

         result = await provider.stream(streamOptsWithSignal);
         if (chunkTimeoutId !== null) clearTimeout(chunkTimeoutId);
      } catch (error: any) {
         if (controller.signal.aborted) {
            throw new Error(abortReason);
         }
         throw error;
      } finally {
         clearTimeout(overallTimeoutId);
      }

      const { cost } = calculateCost(providerName, model, result.usage.inputTokens, result.usage.outputTokens);
      await this.trackCost(cost);

      if (opts.onComplete) opts.onComplete(result);

      logPerformance('llm_streaming_success', startTime, { provider: providerName, model, useCase: opts.useCase, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cost });
      return result;

    } catch (error: any) {
      logger.error({ type: 'llm_streaming_error', provider: providerName, model, error: error.message });
      if (opts.onError) opts.onError(error);
      logPerformance('llm_streaming_failed', startTime, { provider: providerName, model, useCase: opts.useCase });
      throw new Error(`LLM streaming failed: ${error.message}`);
    } finally {
      aiRateLimiter.release();
    }
  }
}

export const llmGateway = new LLMGateway();
