import { LLMProviderName } from './types';
import { logger } from '@/utils/logger';

export interface ModelPricingRates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export const MODEL_PRICING: Record<string, ModelPricingRates> = {
  // Anthropic pricing (USD per 1M tokens)
  // Cache write = 1.25x base input, Cache read = 0.10x base input
  'anthropic:claude-opus-4-6': { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.5 },
  'anthropic:claude-sonnet-4-6': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  'anthropic:claude-haiku-4-5-20251001': { input: 0.8, output: 4.0, cacheWrite: 1.0, cacheRead: 0.08 },
  
  // OpenAI pricing (USD per 1M tokens)
  // Cached prompt tokens = 0.50x base input
  'openai:gpt-4o': { input: 5.0, output: 15.0, cacheWrite: 5.0, cacheRead: 2.5 },
  'openai:gpt-4o-mini': { input: 0.15, output: 0.60, cacheWrite: 0.15, cacheRead: 0.075 },
  
  // Gemini pricing (USD per 1M tokens)
  // Cached prompt tokens = 0.25x base input
  'gemini:gemini-1.5-pro': { input: 3.5, output: 10.5, cacheWrite: 3.5, cacheRead: 0.875 },
  'gemini:gemini-1.5-flash': { input: 0.35, output: 1.05, cacheWrite: 0.35, cacheRead: 0.0875 },
};

const warnedMissingCachePricing = new Set<string>();

/**
 * Get pricing for a specific provider and model.
 * If exact pricing isn't found, returns the most conservative (highest)
 * rate across all known models to fail-safe cost limits.
 */
export function getModelPricing(provider: LLMProviderName, model: string): { 
  input: number; 
  output: number; 
  cacheRead: number; 
  cacheWrite: number; 
  isMissing: boolean;
} {
  const normalizedModel = model.startsWith(`${provider}:`) ? model.slice(provider.length + 1) : model;
  const key = `${provider}:${normalizedModel}`;
  const pricing = MODEL_PRICING[key];

  if (pricing) {
    const cacheRead = pricing.cacheRead ?? pricing.input;
    const cacheWrite = pricing.cacheWrite ?? pricing.input;
    return { ...pricing, cacheRead, cacheWrite, isMissing: false };
  }

  // Find the highest known price to fail-safe the cost limit
  let maxInput = 0;
  let maxOutput = 0;
  let maxCacheRead = 0;
  let maxCacheWrite = 0;

  for (const p of Object.values(MODEL_PRICING)) {
    if (p.input > maxInput) maxInput = p.input;
    if (p.output > maxOutput) maxOutput = p.output;
    if ((p.cacheRead ?? p.input) > maxCacheRead) maxCacheRead = p.cacheRead ?? p.input;
    if ((p.cacheWrite ?? p.input) > maxCacheWrite) maxCacheWrite = p.cacheWrite ?? p.input;
  }

  return { 
    input: maxInput, 
    output: maxOutput, 
    cacheRead: maxCacheRead, 
    cacheWrite: maxCacheWrite, 
    isMissing: true 
  };
}

export interface CacheTokenOptions {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function calculateCost(
  provider: LLMProviderName, 
  model: string, 
  inputTokens: number, 
  outputTokens: number,
  cacheOptions?: CacheTokenOptions
): { cost: number; isMissing: boolean } {
  const pricing = getModelPricing(provider, model);
  const cacheReadTokens = Math.max(0, cacheOptions?.cacheReadTokens || 0);
  const cacheWriteTokens = Math.max(0, cacheOptions?.cacheWriteTokens || 0);

  if (pricing.isMissing && !warnedMissingCachePricing.has(`${provider}:${model}`)) {
    warnedMissingCachePricing.add(`${provider}:${model}`);
    logger.warn({
      type: 'llm_pricing_missing_fallback',
      provider,
      model,
      message: `Unknown pricing for ${provider}:${model}; falling back to standard conservative rates.`
    });
  }

  let effectiveInputCost = 0;

  if (provider === 'anthropic') {
    // Anthropic: inputTokens are uncached; cacheReadTokens and cacheWriteTokens are distinct pools
    const regularInputCost = (inputTokens / 1000000) * pricing.input;
    const writeCost = (cacheWriteTokens / 1000000) * pricing.cacheWrite;
    const readCost = (cacheReadTokens / 1000000) * pricing.cacheRead;
    effectiveInputCost = regularInputCost + writeCost + readCost;
  } else if (provider === 'openai' || provider === 'gemini') {
    // OpenAI & Gemini: inputTokens is total prompt tokens; cacheReadTokens is the cached subset
    const uncachedInputTokens = Math.max(0, inputTokens - cacheReadTokens);
    const regularInputCost = (uncachedInputTokens / 1000000) * pricing.input;
    const readCost = (cacheReadTokens / 1000000) * pricing.cacheRead;
    const writeCost = (cacheWriteTokens / 1000000) * pricing.cacheWrite;
    effectiveInputCost = regularInputCost + readCost + writeCost;
  } else {
    effectiveInputCost = (inputTokens / 1000000) * pricing.input;
  }

  const outputCost = (outputTokens / 1000000) * pricing.output;
  
  return {
    cost: effectiveInputCost + outputCost,
    isMissing: pricing.isMissing
  };
}

export const CURRENT_PRICING_VERSION = '2026.09.v1';

export interface CostWithFxResult {
  cost: number; // backward-compatible USD cost alias
  costUsd: number;
  costKes: number;
  fxRateUsdToKes: number;
  fxRateCapturedAt: Date;
  pricingVersion: string;
  isMissing: boolean;
}

/**
 * Calculates both USD and Kenyan Shillings (KES) costs for an AI request.
 */
export async function calculateCostWithFx(
  provider: LLMProviderName, 
  model: string, 
  inputTokens: number, 
  outputTokens: number,
  cacheOptions?: CacheTokenOptions
): Promise<CostWithFxResult> {
  const { getUsdToKesFxRate } = await import('./fx.service');
  const usdResult = calculateCost(provider, model, inputTokens, outputTokens, cacheOptions);
  const fx = await getUsdToKesFxRate();
  const costKes = usdResult.cost * fx.rate;

  return {
    cost: usdResult.cost,
    costUsd: usdResult.cost,
    costKes,
    fxRateUsdToKes: fx.rate,
    fxRateCapturedAt: fx.capturedAt,
    pricingVersion: CURRENT_PRICING_VERSION,
    isMissing: usdResult.isMissing,
  };
}


