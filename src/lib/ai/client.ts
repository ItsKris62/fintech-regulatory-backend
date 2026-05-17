import Anthropic from '@anthropic-ai/sdk';
import { aiConfig, getModelForUseCase, calculateCost, isRetryableError } from '@/config/ai.config';
import { logger, logPerformance } from '@/utils/logger';
import { redis } from '@/lib/redis/client';
import { getRuntimeAIConfig, getSystemConfigNumber } from '@/lib/system-config';
import { AIServiceError } from '@/utils/error';
import { aiRateLimiter } from './rate-limiter';

/**
 * AI completion options
 */
export interface AICompletionOptions {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  metadata?: Record<string, any>;
  /**
   * Override the overall request timeout (ms).
   * When set, takes precedence over the useCase-derived timeout in stream() and complete().
   * Use this for tier-specific timeouts in the three-tier checklist generation pipeline.
   */
  overrideTimeoutMs?: number;
}

/**
 * AI completion result
 */
export interface AICompletionResult {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  cached?: boolean;
  /** Anthropic stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | null */
  stopReason?: string | null;
}

/**
 * AI streaming options
 */
export interface AIStreamOptions extends AICompletionOptions {
  onChunk?: (chunk: string) => void;
  onComplete?: (result: AICompletionResult) => void;
  onError?: (error: Error) => void;
  /** External abort signal. When fired (e.g. client disconnect), aborts the Anthropic stream. */
  externalAbortSignal?: AbortSignal;
}

let anthropicClientCache: { apiKey: string; client: Anthropic } | null = null;

function getAnthropicClient(apiKey: string): Anthropic {
  if (anthropicClientCache?.apiKey === apiKey) {
    return anthropicClientCache.client;
  }

  const client = new Anthropic({
    apiKey,
    maxRetries: 0, // We'll handle retries ourselves
  });

  anthropicClientCache = { apiKey, client };
  return client;
}

/**
 * Track daily AI costs
 * @param cost Cost in USD
 */
async function trackCost(cost: number): Promise<void> {
  try {
    const today = new Date().toISOString().split('T')[0];
    const key = `ai:cost:${today}`;
    
    await redis.incrbyfloat(key, cost);
    await redis.expire(key, 86400 * 7); // Keep for 7 days

    // Warn at 80 % and log at 100 %  -  the hard block happens in checkCostLimit()
    // before the request is sent, so we only log here (the cost is already spent).
    const totalCost = parseFloat(await redis.get<string>(key) || '0');
    const limit = await getSystemConfigNumber('aiDailyCostLimit', aiConfig.costs.dailyLimit);

    if (totalCost > limit) {
      logger.error({
        type: 'ai_daily_limit_exceeded',
        totalCost,
        limit,
        percentUsed: Math.round((totalCost / limit) * 100),
      });
    } else if (totalCost > limit * 0.8) {
      logger.warn({
        type: 'ai_daily_cost_warning',
        totalCost,
        limit,
        percentUsed: Math.round((totalCost / limit) * 100),
      });
    }
  } catch (error: any) {
    logger.error({
      type: 'ai_cost_tracking_error',
      error: error.message,
    });
  }
}

/**
 * Get today's AI cost
 */
export async function getTodayAICost(): Promise<number> {
  try {
    const today = new Date().toISOString().split('T')[0];
    const key = `ai:cost:${today}`;
    const cost = await redis.get<string>(key);
    return parseFloat(cost || '0');
  } catch (error) {
    return 0;
  }
}

/**
 * Check if daily cost limit would be exceeded.
 * Throws AIServiceError when the limit is already at or above 100 %.
 * Logs a warning when projected usage exceeds 80 %.
 */
async function checkCostLimit(estimatedCost: number): Promise<void> {
  const todayCost = await getTodayAICost();
  const limit = await getSystemConfigNumber('aiDailyCostLimit', aiConfig.costs.dailyLimit);
  const projected = todayCost + estimatedCost;

  if (projected > limit) {
    logger.error({
      type: 'ai_daily_limit_blocked',
      todayCost,
      estimatedCost,
      projected,
      limit,
      percentUsed: Math.round((projected / limit) * 100),
    });
    throw new AIServiceError(
      `Daily AI cost limit of $${limit} exceeded ($${todayCost.toFixed(4)} used today). ` +
      'Requests are blocked until tomorrow or until an admin resets the limit.'
    );
  }

  if (projected > limit * 0.8) {
    logger.warn({
      type: 'ai_daily_cost_warning',
      todayCost,
      estimatedCost,
      projected,
      limit,
      percentUsed: Math.round((projected / limit) * 100),
    });
  }
}

/**
 * Generate cache key for AI completion
 * @param prompt User prompt
 * @param systemPrompt System prompt
 * @param model Model name
 */
function generateCacheKey(
  prompt: string,
  systemPrompt: string = '',
  model: string
): string {
  const content = `${systemPrompt}|${prompt}|${model}`;
  // Simple hash function
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return `ai:cache:${Math.abs(hash).toString(36)}`;
}

/**
 * Get cached AI completion
 * @param cacheKey Cache key
 */
async function getCachedCompletion(
  cacheKey: string
): Promise<AICompletionResult | null> {
  try {
    // @upstash/redis auto-parses JSON  -  get<T> returns T directly, no JSON.parse needed
    const cached = await redis.get<AICompletionResult>(cacheKey);

    if (cached) {
      cached.cached = true;

      logger.info({
        type: 'ai_cache_hit',
        cacheKey,
      });

      return cached;
    }

    return null;
  } catch (error: unknown) {
    logger.warn({
      type: 'ai_cache_get_error',
      cacheKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return null; // Fail open  -  proceed without cache
  }
}

/**
 * Cache AI completion
 * @param cacheKey Cache key
 * @param result Completion result
 * @param ttl Time to live in seconds
 */
async function cacheCompletion(
  cacheKey: string,
  result: AICompletionResult,
  ttl: number
): Promise<void> {
  try {
    // Upstash uses set(..., { ex: ttl })  -  setex is not supported; auto-serializes the object
    await redis.set(cacheKey, result, { ex: ttl });

    logger.info({
      type: 'ai_cache_set',
      cacheKey,
      ttl,
    });
  } catch (error: unknown) {
    logger.warn({
      type: 'ai_cache_set_error',
      cacheKey,
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail open  -  cache is an optimisation, not critical path
  }
}

/**
 * Complete AI request with retries
 * @param options Completion options
 * @param useCase Use case for model selection (optional)
 * @param cacheTTL Cache TTL in seconds (0 = no cache)
 */
export async function complete(
  options: AICompletionOptions,
  useCase?: 'policy' | 'checklist' | 'query' | 'verification',
  cacheTTL: number = 0
): Promise<AICompletionResult> {
  const startTime = Date.now();
  const resolvedAIConfig = await getRuntimeAIConfig(useCase || 'query');
  const anthropic = getAnthropicClient(resolvedAIConfig.apiKey);

  // Select model based on use case or use provided model
  const model = options.model || resolvedAIConfig.model || getModelForUseCase(useCase || 'query');
  const temperature = options.temperature ?? resolvedAIConfig.temperature;
  const maxTokens = options.maxTokens ?? aiConfig.parameters.queryMaxTokens;

  // Check cache if TTL > 0
  if (cacheTTL > 0) {
    const cacheKey = generateCacheKey(options.prompt, options.systemPrompt || '', model);
    const cached = await getCachedCompletion(cacheKey);
    
    if (cached) {
      logPerformance('ai_completion_cached', startTime, { model, useCase });
      return cached;
    }
  }

  // Estimate cost and check limit
  const estimatedInputTokens = Math.ceil(
    (options.prompt.length + (options.systemPrompt?.length || 0)) / 4
  );
  const estimatedCost = calculateCost(model, estimatedInputTokens, maxTokens);
  
  await checkCostLimit(estimatedCost); // throws if daily limit exceeded

  let lastError: Error | null = null;

  await aiRateLimiter.acquire();
  try {

  // Retry loop
  for (let attempt = 1; attempt <= aiConfig.retry.maxAttempts; attempt++) {
    try {
      logger.info({
        type: 'ai_completion_attempt',
        attempt,
        model,
        useCase,
        promptLength: options.prompt.length,
      });

      const messages: Anthropic.MessageParam[] = [
        {
          role: 'user',
          content: options.prompt,
        },
      ];

      // Use a per-request timeout appropriate for the use case
      const timeoutMs =
        useCase === 'policy'     ? aiConfig.timeout.policyGeneration :
        useCase === 'checklist'  ? aiConfig.timeout.checklistGeneration :
                                   aiConfig.timeout.default;

      const response = await anthropic.messages.create(
        {
          model,
          max_tokens: maxTokens,
          temperature,
          system: options.systemPrompt,
          messages,
          stop_sequences: options.stopSequences,
          metadata: options.metadata,
        },
        { timeout: timeoutMs }
      );

      // Extract content
      const content = response.content
        .filter(block => block.type === 'text')
        .map(block => (block as Anthropic.TextBlock).text)
        .join('\n');

      // Calculate actual cost
      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const cost = calculateCost(model, inputTokens, outputTokens);

      // Track cost
      await trackCost(cost);

      const result: AICompletionResult = {
        content,
        model,
        inputTokens,
        outputTokens,
        cost,
        cached: false,
        stopReason: response.stop_reason,
      };

      // Cache result if TTL > 0
      if (cacheTTL > 0) {
        const cacheKey = generateCacheKey(options.prompt, options.systemPrompt || '', model);
        await cacheCompletion(cacheKey, result, cacheTTL);
      }

      logPerformance('ai_completion_success', startTime, {
        model,
        useCase,
        inputTokens,
        outputTokens,
        cost,
        attempt,
      });

      return result;
    } catch (error: any) {
      lastError = error;

      const isRetryable = isRetryableError(error.status);
      
      logger.warn({
        type: 'ai_completion_error',
        attempt,
        error: error.message,
        status: error.status,
        retryable: isRetryable,
      });

      if (!isRetryable || attempt === aiConfig.retry.maxAttempts) {
        break;
      }

      // Wait before retry (exponential backoff)
      const delay = aiConfig.retry.initialDelay * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // All retries failed
  logPerformance('ai_completion_failed', startTime, { model, useCase });

  throw new AIServiceError(
    `AI completion failed after ${aiConfig.retry.maxAttempts} attempts: ${lastError?.message}`
  );

  } finally {
    aiRateLimiter.release();
  }
}

/**
 * Stream AI completion
 * @param options Streaming options
 * @param useCase Use case for model selection
 */
export async function stream(
  options: AIStreamOptions,
  useCase?: 'policy' | 'checklist' | 'query' | 'verification'
): Promise<AICompletionResult> {
  const startTime = Date.now();
  const resolvedAIConfig = await getRuntimeAIConfig(useCase || 'query');
  const anthropic = getAnthropicClient(resolvedAIConfig.apiKey);

  const model = options.model || resolvedAIConfig.model || getModelForUseCase(useCase || 'query');
  const temperature = options.temperature ?? resolvedAIConfig.temperature;
  const maxTokens = options.maxTokens ?? aiConfig.parameters.queryMaxTokens;

  // Check cost limit
  const estimatedInputTokens = Math.ceil(
    (options.prompt.length + (options.systemPrompt?.length || 0)) / 4
  );
  const estimatedCost = calculateCost(model, estimatedInputTokens, maxTokens);
  
  await checkCostLimit(estimatedCost); // throws if daily limit exceeded

  await aiRateLimiter.acquire();
  try {
    logger.info({
      type: 'ai_streaming_started',
      model,
      useCase,
      promptLength: options.prompt.length,
    });

    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: options.prompt,
      },
    ];

    // Dual-timeout: overall cap + per-chunk hang detection.
    // options.overrideTimeoutMs takes precedence; used by the tier system to pass
    // tier-specific budgets (240s / 200s / 150s) without needing new useCase strings.
    const overallTimeoutMs =
      options.overrideTimeoutMs ??
      (useCase === 'policy'    ? aiConfig.timeout.policyGeneration :
       useCase === 'checklist' ? aiConfig.timeout.checklistGeneration :
                                 aiConfig.timeout.default);
    const chunkTimeoutMs = aiConfig.timeout.streamingChunk;

    const controller = new AbortController();
    let abortReason = `AI stream exceeded overall timeout of ${overallTimeoutMs}ms`;

    const overallTimeoutId = setTimeout(() => {
      controller.abort();
    }, overallTimeoutMs);

    // Wire external abort signal (e.g. client disconnect) to the internal controller.
    if (options.externalAbortSignal) {
      if (options.externalAbortSignal.aborted) {
        clearTimeout(overallTimeoutId);
        controller.abort();
      } else {
        options.externalAbortSignal.addEventListener('abort', () => {
          abortReason = 'Client disconnected — stream aborted';
          clearTimeout(overallTimeoutId);
          controller.abort();
        }, { once: true });
      }
    }

    const streamResponse = await anthropic.messages.create(
      {
        model,
        max_tokens: maxTokens,
        temperature,
        system: options.systemPrompt,
        messages,
        stop_sequences: options.stopSequences,
        stream: true,
      },
      { signal: controller.signal }
    );

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let chunkTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const resetChunkTimeout = () => {
      if (chunkTimeoutId !== null) clearTimeout(chunkTimeoutId);
      chunkTimeoutId = setTimeout(() => {
        abortReason = `AI stream hung  -  no data received for ${chunkTimeoutMs}ms`;
        controller.abort();
      }, chunkTimeoutMs);
    };

    try {
      resetChunkTimeout();

      for await (const event of streamResponse) {
        resetChunkTimeout();

        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            const chunk = event.delta.text;
            fullContent += chunk;

            if (options.onChunk) {
              options.onChunk(chunk);
            }
          }
        } else if (event.type === 'message_start') {
          inputTokens = event.message.usage.input_tokens;
        } else if (event.type === 'message_delta') {
          outputTokens = event.usage.output_tokens;
        }
      }
    } catch (streamError: any) {
      // Re-throw with human-readable timeout reason when aborted
      if (controller.signal.aborted) {
        throw new Error(abortReason);
      }
      throw streamError;
    } finally {
      clearTimeout(overallTimeoutId);
      if (chunkTimeoutId !== null) clearTimeout(chunkTimeoutId);
    }

    const cost = calculateCost(model, inputTokens, outputTokens);
    await trackCost(cost);

    const result: AICompletionResult = {
      content: fullContent,
      model,
      inputTokens,
      outputTokens,
      cost,
      cached: false,
    };

    if (options.onComplete) {
      options.onComplete(result);
    }

    logPerformance('ai_streaming_success', startTime, {
      model,
      useCase,
      inputTokens,
      outputTokens,
      cost,
    });

    return result;
  } catch (error: any) {
    logger.error({
      type: 'ai_streaming_error',
      model,
      error: error.message,
    });

    if (options.onError) {
      options.onError(error);
    }

    logPerformance('ai_streaming_failed', startTime, { model, useCase });

    throw new AIServiceError(`AI streaming failed: ${error.message}`);
  } finally {
    aiRateLimiter.release();
  }
}

/**
 * Get AI usage statistics
 */
export async function getAIStats(): Promise<{
  todayCost: number;
  dailyLimit: number;
  remainingBudget: number;
  percentUsed: number;
}> {
  const todayCost = await getTodayAICost();
  const dailyLimit = await getSystemConfigNumber('aiDailyCostLimit', aiConfig.costs.dailyLimit);
  const remainingBudget = Math.max(0, dailyLimit - todayCost);
  const percentUsed = (todayCost / dailyLimit) * 100;

  return {
    todayCost,
    dailyLimit,
    remainingBudget,
    percentUsed,
  };
}

/**
 * Reset daily cost (admin only - use with caution)
 */
export async function resetDailyCost(): Promise<void> {
  try {
    const today = new Date().toISOString().split('T')[0];
    const key = `ai:cost:${today}`;
    await redis.del(key);
    
    logger.warn({
      type: 'ai_daily_cost_reset',
      date: today,
    });
  } catch (error: any) {
    logger.error({
      type: 'ai_cost_reset_error',
      error: error.message,
    });
  }
}

// Export Anthropic client for advanced usage
export { Anthropic };