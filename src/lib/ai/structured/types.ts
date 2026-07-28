import type { z } from 'zod';
import type { LLMProviderName, LLMCompletionRequest } from '../gateway/types';

// Reuses the exact union already defined inline at LLMCompletionRequest['useCase']
// rather than introducing a second, parallel AIUseCase type — Pack 1 procedures
// pass one of these five values, same as every existing gateway caller.
export type AIUseCase = NonNullable<LLMCompletionRequest['useCase']>;

export interface StructuredCompletionResult<T> {
  data: T;
  providerUsed: LLMProviderName;
  modelUsed: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  /** 1 = succeeded on first try, 2 = required the one correction attempt. */
  validationAttempts: number;
  /** sha256 hex of the raw provider response text — for audit correlation, never the text itself. */
  rawResponseHash: string;
}

export interface CompleteStructuredInput<T> {
  useCase: AIUseCase;
  schema: z.ZodType<T>;
  /** For logging/error messages only, e.g. 'EditorialTriageAssessment'. */
  schemaName: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  provider?: LLMProviderName;
  model?: string;
  allowFallback?: boolean;
  /** Default 1, capped at 1 by the type itself — see phase-b-structured-ai-design.md. */
  correctionAttemptLimit?: 0 | 1;
  overrideTimeoutMs?: number;
  signal?: AbortSignal;
}

export type AIStructuredOutputErrorCode =
  | 'NO_JSON_FOUND'
  | 'RESPONSE_TOO_LARGE'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'CORRECTION_FAILED'
  | 'PROVIDER_TIMEOUT'
  | 'BUDGET_EXHAUSTED'
  | 'UNSUPPORTED_PROVIDER'
  | 'FALLBACK_EXHAUSTED'
  | 'INVALID_SCHEMA_CONFIGURATION';
