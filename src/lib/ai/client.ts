import Anthropic from '@anthropic-ai/sdk';
import { aiConfig, getModelForUseCase, calculateCost, isRetryableError } from '@/config/ai.config';
import { logger, logPerformance } from '@/utils/logger';
import { redis } from '@/lib/redis/client';
import { AIServiceError } from '@/utils/error';

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
}

/**
 * AI streaming options
 */
export interface AIStreamOptions extends AICompletionOptions {
  onChunk?: (chunk: string) => void;
  onComplete?: (result: AICompletionResult) => void;
  onError?: (error: Error) => void;
}

/**
 * Initialize Anthropic client
 */
const anthropic = new Anthropic({
  apiKey: aiConfig.api.key,
  maxRetries: 0, // We'll handle retries ourselves
});

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

    // Check if daily limit exceeded
    const totalCost = parseFloat(await redis.get(key) || '0');
    
    if (totalCost > aiConfig.costs.dailyLimit) {
      logger.error({
        type: 'ai_daily_limit_exceeded',
        totalCost,
        limit: aiConfig.costs.dailyLimit,
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
    const cost = await redis.get(key);
    return parseFloat(cost || '0');
  } catch (error) {
    return 0;
  }
}

/**
 * Check if daily cost limit would be exceeded
 * @param estimatedCost Estimated cost for operation
 */
async function checkCostLimit(estimatedCost: number): Promise<boolean> {
  const todayCost = await getTodayAICost();
  return (todayCost + estimatedCost) <= aiConfig.costs.dailyLimit;
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
    const cached = await redis.get(cacheKey);
    
    if (cached) {
      const result = JSON.parse(cached) as AICompletionResult;
      result.cached = true;
      
      logger.info({
        type: 'ai_cache_hit',
        cacheKey,
      });
      
      return result;
    }
    
    return null;
  } catch (error) {
    return null;
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
    await redis.setex(cacheKey, ttl, JSON.stringify(result));
    
    logger.info({
      type: 'ai_cache_set',
      cacheKey,
      ttl,
    });
  } catch (error: any) {
    logger.error({
      type: 'ai_cache_error',
      error: error.message,
    });
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
  useCase?: 'policy' | 'query' | 'verification',
  cacheTTL: number = 0
): Promise<AICompletionResult> {
  const startTime = Date.now();

  // Select model based on use case or use provided model
  const model = options.model || getModelForUseCase(useCase || 'query');
  const temperature = options.temperature ?? aiConfig.parameters.queryTemperature;
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
  
  const withinLimit = await checkCostLimit(estimatedCost);
  if (!withinLimit) {
    throw new AIServiceError('Daily AI cost limit exceeded');
  }

  let lastError: Error | null = null;

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

      // Use a per-request timeout; checklist/policy generation can take 90-120s
      const timeoutMs =
        useCase === 'policy'
          ? aiConfig.timeout.policyGeneration
          : aiConfig.timeout.default;

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
}

/**
 * Stream AI completion
 * @param options Streaming options
 * @param useCase Use case for model selection
 */
export async function stream(
  options: AIStreamOptions,
  useCase?: 'policy' | 'query' | 'verification'
): Promise<AICompletionResult> {
  const startTime = Date.now();

  const model = options.model || getModelForUseCase(useCase || 'query');
  const temperature = options.temperature ?? aiConfig.parameters.queryTemperature;
  const maxTokens = options.maxTokens ?? aiConfig.parameters.queryMaxTokens;

  // Check cost limit
  const estimatedInputTokens = Math.ceil(
    (options.prompt.length + (options.systemPrompt?.length || 0)) / 4
  );
  const estimatedCost = calculateCost(model, estimatedInputTokens, maxTokens);
  
  const withinLimit = await checkCostLimit(estimatedCost);
  if (!withinLimit) {
    throw new AIServiceError('Daily AI cost limit exceeded');
  }

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

    const stream = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: options.systemPrompt,
      messages,
      stop_sequences: options.stopSequences,
      stream: true,
    });

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of stream) {
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
  const dailyLimit = aiConfig.costs.dailyLimit;
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
export { anthropic };