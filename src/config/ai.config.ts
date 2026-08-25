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
    default: appConfig.ai.model || 'anthropic:claude-3-5-sonnet-latest',

    // Policy generation (Sonnet 4.6 for balance of speed/quality)
    policyGeneration: appConfig.ai.model || 'anthropic:claude-3-5-sonnet-latest',
    
    // Checklist generation
    checklistGeneration: appConfig.ai.model || 'anthropic:claude-3-5-sonnet-latest',
    
    // Compliance query
    complianceQuery: appConfig.ai.model || 'anthropic:claude-3-5-sonnet-latest',
    
    // Citation verification
    citationVerification: appConfig.ai.model || 'anthropic:claude-3-5-sonnet-latest',
    
    // Complex analysis
    complexAnalysis: appConfig.ai.model || 'anthropic:claude-3-5-sonnet-latest',
    
    // Embedding model (currently just placeholder for future usage)
    embedding: appConfig.ai.model || 'anthropic:claude-3-5-sonnet-latest',
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

    // Maximum tokens for checklist generation  -  8192 ensures a full 30+ item checklist
    // never gets truncated mid-JSON (old 3000 limit caused position-12411 parse failures)
    checklistMaxTokens: 8192,

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

    // Checklist generation timeout  -  200s for 8192-token responses + RAG overhead at Sonnet throughput
    checklistGeneration: 200000, // 200 seconds (legacy / non-tier path)

    // Three-tier checklist generation timeouts.
    // Tier 1 is generous because 8192 max_tokens at Sonnet 4.6 throughput (~30 t/s) can reach 270s.
    // Tier 2 and 3 have lower token budgets so shorter timeouts are appropriate.
    checklistTier1: 240000, // 240 seconds (4 min)  -  Tier 1: full prompt, 8192 tokens
    checklistTier2: 200000, // 200 seconds  -  Tier 2: simplified prompt, 6144 tokens
    checklistTier3: 150000, // 150 seconds  -  Tier 3: minimal prompt, 4096 tokens

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
    // 529 = Anthropic overloaded  -  added alongside 408/429 as a common transient failure
    retryableStatuses: [408, 429, 500, 502, 503, 504, 529],

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

    // Pricing has been moved to src/lib/ai/gateway/pricing.ts

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
  useCase: 'policy' | 'checklist' | 'query' | 'verification' | 'analysis' | 'default'
): string {
  const modelMap = {
    policy:       aiConfig.models.policyGeneration,
    checklist:    aiConfig.models.checklistGeneration,
    query:        aiConfig.models.complianceQuery,
    verification: aiConfig.models.citationVerification,
    analysis:     aiConfig.models.complexAnalysis,
    default:      aiConfig.models.default,
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

// calculateCost has been moved to src/lib/ai/gateway/pricing.ts

/**
 * Export type
 */
export type AIConfig = typeof aiConfig;