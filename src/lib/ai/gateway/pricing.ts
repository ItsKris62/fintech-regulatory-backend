import { LLMProviderName } from './types';

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic pricing (USD per 1M tokens)
  'anthropic:claude-opus-4-6': { input: 15.0, output: 75.0 },
  'anthropic:claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'anthropic:claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
  
  // OpenAI pricing (USD per 1M tokens)
  'openai:gpt-4o': { input: 5.0, output: 15.0 },
  'openai:gpt-4o-mini': { input: 0.15, output: 0.60 },
  
  // Gemini pricing (USD per 1M tokens)
  'gemini:gemini-1.5-pro': { input: 3.5, output: 10.5 },
  'gemini:gemini-1.5-flash': { input: 0.35, output: 1.05 },
};

/**
 * Get pricing for a specific provider and model.
 * If exact pricing isn't found, returns the most conservative (highest)
 * rate across all known models to fail-safe cost limits.
 */
export function getModelPricing(provider: LLMProviderName, model: string): { input: number; output: number; isMissing: boolean } {
  const normalizedModel = model.startsWith(`${provider}:`) ? model.slice(provider.length + 1) : model;
  const key = `${provider}:${normalizedModel}`;
  const pricing = MODEL_PRICING[key];

  if (pricing) {
    return { ...pricing, isMissing: false };
  }

  // Find the highest known price to fail-safe the cost limit
  let maxInput = 0;
  let maxOutput = 0;
  for (const p of Object.values(MODEL_PRICING)) {
    if (p.input > maxInput) maxInput = p.input;
    if (p.output > maxOutput) maxOutput = p.output;
  }

  return { input: maxInput, output: maxOutput, isMissing: true };
}

export function calculateCost(provider: LLMProviderName, model: string, inputTokens: number, outputTokens: number): { cost: number; isMissing: boolean } {
  const pricing = getModelPricing(provider, model);
  const inputCost = (inputTokens / 1000000) * pricing.input;
  const outputCost = (outputTokens / 1000000) * pricing.output;
  
  return {
    cost: inputCost + outputCost,
    isMissing: pricing.isMissing
  };
}
