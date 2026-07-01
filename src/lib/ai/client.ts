import Anthropic from '@anthropic-ai/sdk';
import { llmGateway } from './gateway/llm-gateway';
import { LLMCompletionRequest, LLMStreamOptions } from './gateway/types';
import { calculateCost } from './gateway/pricing';
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

/**
 * Get today's AI cost
 */
export async function getTodayAICost(): Promise<number> {
  return llmGateway.getTodayAICost();
}

/**
 * Reset daily cost (admin only - use with caution)
 */
export async function resetDailyCost(): Promise<void> {
  return llmGateway.resetDailyCost();
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
  return llmGateway.getAIStats();
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
  const req: LLMCompletionRequest = {
    ...options,
    provider: 'anthropic',
    useCase,
  };

  try {
    const res = await llmGateway.complete(req, cacheTTL);
    const { cost } = calculateCost(res.provider, res.model, res.usage.inputTokens, res.usage.outputTokens);
    
    return {
      content: res.content,
      model: res.model,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cost,
      cached: res.cached,
      stopReason: res.stopReason,
    };
  } catch (error: any) {
    if (error.name === 'LLMCostLimitError') {
      throw new AIServiceError(error.message);
    }
    // original code says: AI completion failed after 3 attempts: ${error.message}
    // llm-gateway throws the inner error natively. We wrap it for backward compatibility.
    throw new AIServiceError(`AI completion failed after 3 attempts: ${error.message}`);
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
  const opts: LLMStreamOptions = {
    ...options,
    provider: 'anthropic',
    useCase,
    onChunk: options.onChunk,
    onComplete: options.onComplete ? (res) => {
      const { cost } = calculateCost(res.provider, res.model, res.usage.inputTokens, res.usage.outputTokens);
      options.onComplete!({
        content: res.content,
        model: res.model,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        cost,
        cached: res.cached,
        stopReason: res.stopReason,
      });
    } : undefined,
    onError: options.onError,
  };

  try {
    const res = await llmGateway.stream(opts);
    const { cost } = calculateCost(res.provider, res.model, res.usage.inputTokens, res.usage.outputTokens);
    
    return {
      content: res.content,
      model: res.model,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cost,
      cached: res.cached,
      stopReason: res.stopReason,
    };
  } catch (error: any) {
    if (error.name === 'LLMCostLimitError') {
      throw new AIServiceError(error.message);
    }
    throw new AIServiceError(error.message.includes('LLM streaming failed') ? error.message : `AI streaming failed: ${error.message}`);
  }
}

// Export Anthropic client for advanced usage
export { Anthropic };