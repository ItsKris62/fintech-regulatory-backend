import crypto from 'crypto';
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

export interface MonthlyBudgetStatus {
  period: string;
  budgetUsd: number;
  spentUsd: number;
  reservedUsd: number;
  remainingUsd: number;
  percentUsed: number;
  providers: Record<LLMProviderName, number>;
}

export function getCurrentBudgetPeriod(date: Date = new Date()): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Nairobi',
      year: 'numeric',
      month: '2-digit',
    });
    return formatter.format(date); // YYYY-MM
  } catch {
    return date.toISOString().slice(0, 7);
  }
}

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

  async getMonthlyBudgetLimit(): Promise<number> {
    return getSystemConfigNumber('aiMonthlyBudgetUsd', aiConfig.costs.monthlyBudgetUsd || 20.0);
  }

  async getMonthlyGlobalSpend(period: string = getCurrentBudgetPeriod()): Promise<number> {
    try {
      const key = `ai:cost:global:${period}`;
      const val = await redis.get<string>(key);
      return parseFloat(val || '0') || 0;
    } catch {
      return 0;
    }
  }

  async getMonthlyGlobalReserved(period: string = getCurrentBudgetPeriod()): Promise<number> {
    try {
      const key = `ai:cost:global:reserved:${period}`;
      const val = await redis.get<string>(key);
      return Math.max(0, parseFloat(val || '0') || 0);
    } catch {
      return 0;
    }
  }

  async getMonthlyProviderSpend(provider: LLMProviderName, period: string = getCurrentBudgetPeriod()): Promise<number> {
    try {
      const key = `ai:cost:provider:${provider}:${period}`;
      const val = await redis.get<string>(key);
      return parseFloat(val || '0') || 0;
    } catch {
      return 0;
    }
  }

  async getMonthlyBudgetStatus(period: string = getCurrentBudgetPeriod()): Promise<MonthlyBudgetStatus> {
    const budgetUsd = await this.getMonthlyBudgetLimit();
    const spentUsd = await this.getMonthlyGlobalSpend(period);
    const reservedUsd = await this.getMonthlyGlobalReserved(period);

    const [anthropicSpend, openaiSpend, geminiSpend] = await Promise.all([
      this.getMonthlyProviderSpend('anthropic', period),
      this.getMonthlyProviderSpend('openai', period),
      this.getMonthlyProviderSpend('gemini', period),
    ]);

    const totalActive = spentUsd + reservedUsd;
    const remainingUsd = Math.max(0, parseFloat((budgetUsd - totalActive).toFixed(4)));
    const percentUsed = budgetUsd > 0 ? Math.min(100, parseFloat(((totalActive / budgetUsd) * 100).toFixed(2))) : 100;

    return {
      period,
      budgetUsd,
      spentUsd: parseFloat(spentUsd.toFixed(4)),
      reservedUsd: parseFloat(reservedUsd.toFixed(4)),
      remainingUsd,
      percentUsed,
      providers: {
        anthropic: parseFloat(anthropicSpend.toFixed(4)),
        openai: parseFloat(openaiSpend.toFixed(4)),
        gemini: parseFloat(geminiSpend.toFixed(4)),
      },
    };
  }

  /**
   * Concurrency-safe atomic reservation of estimated cost before initiating AI call.
   */
  async reserveBudget(
    estimatedCost: number,
    period: string = getCurrentBudgetPeriod()
  ): Promise<{ period: string; reservedAmount: number }> {
    const budgetLimit = await this.getMonthlyBudgetLimit();
    const safeEstimatedCost = Math.max(0, estimatedCost);
    const reserveKey = `ai:cost:global:reserved:${period}`;
    const ttl = 86400 * 60; // 60 days

    // Atomic reservation attempt
    const currentSpent = await this.getMonthlyGlobalSpend(period);
    const currentReserved = await this.getMonthlyGlobalReserved(period);
    const projected = currentSpent + currentReserved + safeEstimatedCost;

    if (projected > budgetLimit) {
      logger.error({
        type: 'ai_monthly_limit_blocked',
        period,
        currentSpent,
        currentReserved,
        estimatedCost: safeEstimatedCost,
        projected,
        budgetLimit,
        percentUsed: Math.round((projected / budgetLimit) * 100),
      });
      throw new LLMCostLimitError(
        `Global monthly AI budget of $${budgetLimit} exceeded ($${(currentSpent + currentReserved).toFixed(4)} used/reserved in ${period}). Requests are blocked.`
      );
    }

    if (safeEstimatedCost > 0) {
      await redis.incrbyfloat(reserveKey, safeEstimatedCost);
      await redis.expire(reserveKey, ttl);
    }

    return { period, reservedAmount: safeEstimatedCost };
  }

  /**
   * Reconciles atomic reservation against actual provider token usage.
   */
  async reconcileReservation(
    period: string,
    reservedAmount: number,
    actualCost: number,
    providerName: LLMProviderName
  ): Promise<void> {
    try {
      const reserveKey = `ai:cost:global:reserved:${period}`;
      const spendKey = `ai:cost:global:${period}`;
      const providerKey = `ai:cost:provider:${providerName}:${period}`;
      const ttl = 86400 * 60; // 60 days

      // 1. Release reservation
      if (reservedAmount > 0) {
        const rawReserved = await redis.incrbyfloat(reserveKey, -reservedAmount);
        const updatedReserved = parseFloat(String(rawReserved));
        if (updatedReserved <= 0) {
          await redis.set(reserveKey, '0', { ex: ttl });
        }
      }

      // 2. Track actual spend
      if (actualCost > 0) {
        await redis.incrbyfloat(spendKey, actualCost);
        await redis.expire(spendKey, ttl);

        await redis.incrbyfloat(providerKey, actualCost);
        await redis.expire(providerKey, ttl);

        // 3. Evaluate operational warning thresholds (50%, 75%, 90%, 100%)
        const totalSpent = await this.getMonthlyGlobalSpend(period);
        const budgetLimit = await this.getMonthlyBudgetLimit();
        const thresholdKey = `ai:cost:global:thresholds:${period}`;

        const thresholds = [0.5, 0.75, 0.9, 1.0];
        for (const th of thresholds) {
          if (totalSpent >= budgetLimit * th) {
            const thName = `${Math.round(th * 100)}%`;
            const isNotified = await redis.sismember(thresholdKey, thName).catch(() => 0);
            if (!isNotified) {
              await redis.sadd(thresholdKey, thName).catch(() => {});
              await redis.expire(thresholdKey, ttl).catch(() => {});
              if (th >= 1.0) {
                logger.error({
                  type: 'ai_monthly_budget_exhausted',
                  period,
                  totalSpent,
                  budgetLimit,
                  percentUsed: Math.round((totalSpent / budgetLimit) * 100),
                });
              } else {
                logger.warn({
                  type: 'ai_monthly_budget_threshold_reached',
                  period,
                  threshold: thName,
                  totalSpent,
                  budgetLimit,
                  percentUsed: Math.round((totalSpent / budgetLimit) * 100),
                });
              }
            }
          }
        }
      }
    } catch (error: any) {
      logger.error({ type: 'ai_cost_reconciliation_error', period, error: error.message });
    }
  }

  async trackCost(cost: number, providerName?: LLMProviderName): Promise<void> {
    if (cost <= 0) return;
    const period = getCurrentBudgetPeriod();
    await this.reconcileReservation(period, 0, cost, providerName || 'anthropic');
  }

  async checkCostLimit(estimatedCost: number, _provider?: LLMProviderName): Promise<void> {
    const period = getCurrentBudgetPeriod();
    const budgetLimit = await this.getMonthlyBudgetLimit();
    const currentSpent = await this.getMonthlyGlobalSpend(period);
    const currentReserved = await this.getMonthlyGlobalReserved(period);
    const projected = currentSpent + currentReserved + estimatedCost;

    if (projected > budgetLimit) {
      logger.error({
        type: 'ai_monthly_limit_blocked',
        period,
        currentSpent,
        currentReserved,
        estimatedCost,
        projected,
        budgetLimit,
        percentUsed: Math.round((projected / budgetLimit) * 100),
      });
      throw new LLMCostLimitError(
        `Global monthly AI budget of $${budgetLimit} exceeded ($${(currentSpent + currentReserved).toFixed(4)} used/reserved in ${period}). Requests are blocked.`
      );
    }
  }

  // Backward-compatibility helpers
  async getTodayAICost(): Promise<number> {
    return this.getMonthlyGlobalSpend();
  }

  async getTodayProviderAICost(provider: LLMProviderName): Promise<number> {
    return this.getMonthlyProviderSpend(provider);
  }

  async resetDailyCost(): Promise<void> {
    const period = getCurrentBudgetPeriod();
    await redis.del(`ai:cost:global:${period}`);
    await redis.del(`ai:cost:global:reserved:${period}`);
  }

  async getAIStats(): Promise<{ todayCost: number; dailyLimit: number; remainingBudget: number; percentUsed: number; }> {
    const status = await this.getMonthlyBudgetStatus();
    return {
      todayCost: status.spentUsd,
      dailyLimit: status.budgetUsd,
      remainingBudget: status.remainingUsd,
      percentUsed: status.percentUsed,
    };
  }

  generateCacheKey(
    provider: LLMProviderName,
    model: string,
    prompt: string,
    systemPrompt: string = '',
    scope?: string | { orgId?: string; globalCache?: boolean } | null
  ): string {
    const orgId = typeof scope === 'string' ? scope : scope?.orgId;
    const isGlobal = typeof scope === 'object' && scope?.globalCache === true;

    if (!orgId && !isGlobal) {
      throw new Error(
        'Tenant orgId is required for AI cache key generation unless globalCache is explicitly set to true'
      );
    }

    const tenantPrefix = isGlobal ? 'global' : orgId!;
    const payload = `${tenantPrefix}:${systemPrompt}:${prompt}:${model}`;
    const hash = crypto.createHash('sha256').update(payload).digest('hex');
    return `ai:cache:${provider}:${hash}`;
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
    let providerName = req.provider || 'anthropic';
    let model = req.model;
    if (!model) {
      if (req.provider === 'openai') model = appConfig.openai.model;
      else if (req.provider === 'gemini') model = appConfig.gemini.model;
      else if (req.provider === 'anthropic') model = appConfig.ai.model;
      else model = resolvedAIConfig.model || appConfig.ai.model;
    }
    if (!model) {
      throw new LLMProviderNotConfiguredError(providerName as LLMProviderName);
    }
    if (req.model && model.startsWith('openai:')) {
      providerName = 'openai';
    } else if (req.model && model.startsWith('gemini:')) {
      providerName = 'gemini';
    } else if (req.model && model.startsWith('claude-')) {
      providerName = 'anthropic';
    }
    return { provider: providerName as LLMProviderName, model };
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
      const scope = {
        orgId: req.orgId ?? req.metadata?.orgId ?? req.metadata?.organizationId,
        globalCache: req.globalCache,
      };
      if (!scope.orgId && !scope.globalCache) {
        throw new Error(
          'LLMCompletionRequest requires a valid orgId or explicit globalCache: true for tenant cache isolation'
        );
      }
      const cacheKey = this.generateCacheKey(providerName, model, req.prompt, req.systemPrompt, scope);
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

    // Concurrency-safe atomic budget reservation
    const reservation = await this.reserveBudget(estimatedCost);

    let lastError: Error | null = null;
    let actualCost = 0;

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
          actualCost = cost;

          if (cacheTTL > 0) {
            const scope = {
              orgId: req.orgId ?? req.metadata?.orgId ?? req.metadata?.organizationId,
              globalCache: req.globalCache,
            };
            const cacheKey = this.generateCacheKey(providerName, model, req.prompt, req.systemPrompt, scope);
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
         // Release previous reservation before attempting fallback
         await this.reconcileReservation(reservation.period, reservation.reservedAmount, 0, providerName);
         reservation.reservedAmount = 0; // cleared

         const fallbacks: LLMProviderName[] = ['openai', 'anthropic', 'gemini'];
         for (const fb of fallbacks) {
            if (fb !== providerName) {
               try {
                  this.getProvider(fb); // ensures it is configured
                  logger.warn({ type: 'llm_fallback_used', from: providerName, to: fb, originalError: lastError.message });
                  const reqFallback = { ...req, provider: fb, model: undefined, allowFallback: false };
                  return await this.complete(reqFallback, cacheTTL);
               } catch (e) {
                 // Ignore unconfigured or budget-exhausted fallback
               }
            }
         }
      }

      logPerformance('llm_completion_failed', startTime, { provider: providerName, model, useCase: req.useCase });
      throw lastError;

    } finally {
      aiRateLimiter.release();
      // Reconcile remaining reservation
      if (reservation.reservedAmount > 0 || actualCost > 0) {
        await this.reconcileReservation(reservation.period, reservation.reservedAmount, actualCost, providerName);
      }
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
    
    const reservation = await this.reserveBudget(estimatedCost);
    let actualCost = 0;

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
      actualCost = cost;

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
      if (reservation.reservedAmount > 0 || actualCost > 0) {
        await this.reconcileReservation(reservation.period, reservation.reservedAmount, actualCost, providerName);
      }
    }
  }
}

export const llmGateway = new LLMGateway();
