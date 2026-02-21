import { appConfig } from './app.config';

/**
 * AI configuration for Anthropic Claude
 * Settings for policy generation and compliance queries
 */
export const aiConfig = {
  /**
   * Anthropic API configuration
   */
  api: {
    key: appConfig.ai.apiKey,
    baseUrl: 'https://api.anthropic.com/v1',
    version: '2023-06-01', // API version header
  },

  /**
   * Model configuration
   * Different models for different use cases
   */
  models: {
    // Default model for most operations
    default: appConfig.ai.model,

    // Policy generation (use Sonnet for balance of speed/quality)
    policyGeneration: 'claude-3-sonnet-20240229',

    // Compliance queries (use Haiku for speed)
    complianceQuery: 'claude-3-haiku-20240307',

    // Citation verification (use Haiku for cost efficiency)
    citationVerification: 'claude-3-haiku-20240307',

    // Complex analysis (use Opus for highest quality)
    complexAnalysis: 'claude-3-opus-20240229',

    // Embedding generation (if using Claude for embeddings)
    embedding: 'claude-3-haiku-20240307',
  },

  /**
   * Generation parameters
   */
  parameters: {
    // Temperature for policy generation (lower = more focused)
    policyTemperature: 0.3,

    // Temperature for compliance queries (slightly higher for variety)
    queryTemperature: 0.5,

    // Maximum tokens for policy generation
    policyMaxTokens: 4000,

    // Maximum tokens for compliance queries
    queryMaxTokens: 2000,

    // Maximum tokens for citation verification
    verificationMaxTokens: 500,

    // Top-p (nucleus sampling)
    topP: 1.0,

    // Top-k sampling
    topK: 0,
  },

  /**
   * Timeout configuration (milliseconds)
   */
  timeout: {
    // Standard API call timeout
    default: 60000, // 60 seconds

    // Policy generation timeout (can take longer)
    policyGeneration: 120000, // 120 seconds

    // Compliance query timeout
    complianceQuery: 45000, // 45 seconds

    // Streaming timeout per chunk
    streamingChunk: 10000, // 10 seconds
  },

  /**
   * Retry configuration for API failures
   */
  retry: {
    // Maximum number of retry attempts
    maxAttempts: 3,

    // Initial delay between retries (ms)
    initialDelay: 1000,

    // Maximum delay between retries (ms)
    maxDelay: 10000,

    // Exponential backoff multiplier
    backoffMultiplier: 2,

    // Retry on these HTTP status codes
    retryableStatuses: [408, 429, 500, 502, 503, 504],

    // Retry on these error types
    retryableErrors: ['timeout', 'network', 'overloaded'],
  },

  /**
   * Rate limiting to stay within Anthropic limits
   */
  rateLimit: {
    // Requests per minute
    requestsPerMinute: 50,

    // Tokens per minute (approximate)
    tokensPerMinute: 100000,

    // Concurrent requests
    maxConcurrent: 5,
  },

  /**
   * Cost tracking configuration
   */
  costs: {
    // Enable cost tracking
    enabled: true,

    // Model pricing (USD per 1M tokens)
    pricing: {
      'claude-3-opus-20240229': { input: 15.0, output: 75.0 },
      'claude-3-sonnet-20240229': { input: 3.0, output: 15.0 },
      'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
    },

    // Warning threshold (USD)
    warningThreshold: 100,

    // Maximum cost per day (USD)
    dailyLimit: 500,
  },

  /**
   * Caching configuration
   * Cache responses to reduce API calls and costs
   */
  caching: {
    // Enable response caching
    enabled: true,

    // Cache TTL for different query types (seconds)
    ttl: {
      policyGeneration: 3600, // 1 hour (policies are unique)
      complianceQuery: 86400, // 24 hours (queries might repeat)
      citationVerification: 604800, // 7 days (verifications don't change)
    },

    // Cache key prefix
    keyPrefix: 'claude:cache:',
  },

  /**
   * Streaming configuration
   */
  streaming: {
    // Enable streaming for long-running operations
    enabled: true,

    // Buffer size for streaming responses
    bufferSize: 1024,

    // Emit progress events every N characters
    progressInterval: 100,
  },

  /**
   * System prompts configuration
   */
  systemPrompts: {
    // Kenyan context emphasis
    kenyanContext: 'You are an expert on Kenyan regulatory law and compliance. Always cite specific Kenyan legislation with section numbers.',

    // JSON output enforcement
    jsonOutput: 'Always respond with valid JSON. Do not include any text before or after the JSON object.',

    // Citation requirements
    citationRequirement: 'Every regulatory statement must include a citation to the specific Kenyan law, section, and subsection.',
  },

  /**
   * Safety and content filtering
   */
  safety: {
    // Content filtering level
    filterLevel: 'moderate',

    // Block harmful content
    blockHarmful: true,

    // Log flagged content
    logFlagged: true,
  },

  /**
   * Logging configuration
   */
  logging: {
    // Log all API calls in development
    logCalls: appConfig.isDevelopment,

    // Log token usage always (for cost tracking)
    logTokens: true,

    // Log prompts and responses in development
    logContent: appConfig.isDevelopment,

    // Log only errors in production
    logErrorsOnly: appConfig.isProduction,
  },
} as const;

/**
 * Get model for specific use case
 * @param useCase The use case for model selection
 * @returns Model ID string
 */
export function getModelForUseCase(
  useCase: 'policy' | 'query' | 'verification' | 'analysis' | 'default'
): string {
  const modelMap = {
    policy: aiConfig.models.policyGeneration,
    query: aiConfig.models.complianceQuery,
    verification: aiConfig.models.citationVerification,
    analysis: aiConfig.models.complexAnalysis,
    default: aiConfig.models.default,
  };

  return modelMap[useCase] || aiConfig.models.default;
}

/**
 * Calculate retry delay with exponential backoff
 * @param attemptNumber Current attempt number (1-indexed)
 * @returns Delay in milliseconds
 */
export function getRetryDelay(attemptNumber: number): number {
  const { initialDelay, maxDelay, backoffMultiplier } = aiConfig.retry;

  const delay = initialDelay * Math.pow(backoffMultiplier, attemptNumber - 1);
  return Math.min(delay, maxDelay);
}

/**
 * Check if error is retryable
 * @param error Error object or status code
 * @returns true if should retry
 */
export function isRetryableError(error: any): boolean {
  // Check status code
  if (typeof error === 'number') {
    return (aiConfig.retry.retryableStatuses as readonly number[]).includes(error);
  }

  // Check error type/message
  if (error?.type) {
    return aiConfig.retry.retryableErrors.includes(error.type);
  }

  if (error?.message) {
    const message = error.message.toLowerCase();
    return aiConfig.retry.retryableErrors.some((type) => message.includes(type));
  }

  return false;
}

/**
 * Calculate cost for token usage
 * @param model Model ID
 * @param inputTokens Number of input tokens
 * @param outputTokens Number of output tokens
 * @returns Cost in USD
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = aiConfig.costs.pricing[model as keyof typeof aiConfig.costs.pricing];

  if (!pricing) {
    console.warn(`No pricing info for model: ${model}`);
    return 0;
  }

  const inputCost = (inputTokens / 1000000) * pricing.input;
  const outputCost = (outputTokens / 1000000) * pricing.output;

  return inputCost + outputCost;
}

/**
 * Export type
 */
export type AIConfig = typeof aiConfig;