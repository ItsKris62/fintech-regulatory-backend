import { createHash } from 'node:crypto';
import { z } from 'zod';
import { logger } from '@/utils/logger';
import { llmGateway as defaultLlmGateway } from '../gateway/llm-gateway';
import { calculateCost } from '../gateway/pricing';
import {
  LLMCostLimitError,
  LLMProviderNotConfiguredError,
  type LLMCompletionRequest,
  type LLMCompletionResult,
} from '../gateway/types';
import { AIStructuredOutputError } from './errors';
import { extractJsonCandidate, MAX_STRUCTURED_RESPONSE_LENGTH } from './extract-json';
import { summarizeZodIssuesForCorrection, type CorrectionIssueSummary } from './redact';
import type { CompleteStructuredInput, StructuredCompletionResult } from './types';

export type { AIUseCase, StructuredCompletionResult, CompleteStructuredInput } from './types';
export { AIStructuredOutputError } from './errors';

// Plain function-type interface (rather than Pick<typeof defaultLlmGateway, 'complete'>)
// so a vi.fn() mock is structurally assignable in tests without fighting the
// class method's exact call-signature/variance in TypeScript.
export interface StructuredCompletionGateway {
  complete(req: LLMCompletionRequest, cacheTTL?: number): Promise<LLMCompletionResult>;
}

export interface CompleteStructuredDependencies {
  llmGateway?: StructuredCompletionGateway;
}

type ParseOutcome<T> =
  | { success: true; data: T }
  | { success: false; issues: CorrectionIssueSummary[] };

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Parses+validates a raw model response against `schema`. Never throws for a
 * validation failure — only for RESPONSE_TOO_LARGE/NO_JSON_FOUND, which are
 * distinct, unambiguous failure modes worth surfacing immediately rather than
 * feeding into a correction attempt that can't possibly help (there is no
 * JSON to correct).
 */
function parseAgainstSchema<T>(
  rawText: string,
  schema: z.ZodType<T>,
  schemaName: string,
): ParseOutcome<T> {
  if (rawText.length > MAX_STRUCTURED_RESPONSE_LENGTH) {
    throw new AIStructuredOutputError(
      'RESPONSE_TOO_LARGE',
      `Response for schema "${schemaName}" exceeded ${MAX_STRUCTURED_RESPONSE_LENGTH} characters.`,
      { schemaName, length: rawText.length },
    );
  }

  const candidate = extractJsonCandidate(rawText);
  if (candidate === null) {
    throw new AIStructuredOutputError(
      'NO_JSON_FOUND',
      `No JSON object found in model response for schema "${schemaName}".`,
      { schemaName },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error: unknown) {
    return {
      success: false,
      issues: [{ path: '(root)', message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, issues: summarizeZodIssuesForCorrection(result.error) };
}

function mapGatewayError(error: unknown, schemaName: string, allowFallback?: boolean): AIStructuredOutputError {
  if (error instanceof AIStructuredOutputError) return error;

  if (error instanceof LLMProviderNotConfiguredError) {
    return new AIStructuredOutputError('UNSUPPORTED_PROVIDER', error.message, { schemaName });
  }
  if (error instanceof LLMCostLimitError) {
    return new AIStructuredOutputError('BUDGET_EXHAUSTED', error.message, { schemaName });
  }

  const message = error instanceof Error ? error.message : String(error);

  // The gateway itself already exhausts its own retry+fallback logic before an
  // error ever reaches this layer — anything surfacing here is a terminal
  // failure. Timeout/abort-shaped messages get their own code; everything else
  // is FALLBACK_EXHAUSTED when a fallback was actually permitted (meaning the
  // gateway tried every configured provider and still failed), else the
  // generic timeout bucket, since no finer-grained code exists in this
  // layer's fixed taxonomy for an otherwise-unclassified provider failure.
  if (/abort|timeout|timed out/i.test(message)) {
    return new AIStructuredOutputError('PROVIDER_TIMEOUT', message, { schemaName });
  }
  if (allowFallback) {
    return new AIStructuredOutputError('FALLBACK_EXHAUSTED', message, { schemaName });
  }
  return new AIStructuredOutputError('PROVIDER_TIMEOUT', message, { schemaName });
}

/**
 * Schema-validated structured completion, layered strictly on top of the
 * existing LLMGateway — never bypasses its cost tracking, budget checks,
 * retry/timeout, or fallback logic. See
 * docs/editorial-intelligence/phase-b-structured-ai-design.md for the full
 * design rationale.
 */
export async function completeStructured<T>(
  input: CompleteStructuredInput<T>,
  deps: CompleteStructuredDependencies = {},
): Promise<StructuredCompletionResult<T>> {
  const gateway = deps.llmGateway ?? defaultLlmGateway;
  const correctionLimit = input.correctionAttemptLimit ?? 1;

  let jsonSchema: unknown;
  try {
    jsonSchema = z.toJSONSchema(input.schema as z.ZodType);
  } catch (error: unknown) {
    throw new AIStructuredOutputError(
      'INVALID_SCHEMA_CONFIGURATION',
      `Schema "${input.schemaName}" could not be converted to a JSON Schema summary.`,
      { schemaName: input.schemaName, error: error instanceof Error ? error.message : String(error) },
    );
  }

  // Appended to the caller's systemPrompt, never derived from or concatenated
  // with userPrompt/source content — preserves the caller's own system-prompt
  // authority over domain content while making the response-format contract
  // machine-checkable.
  const effectiveSystemPrompt = [
    input.systemPrompt,
    '',
    'Respond with a single JSON object only. Do not include markdown code fences, prose before or after the JSON, or explanatory text. The JSON must match this shape:',
    JSON.stringify(jsonSchema),
  ].join('\n');

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let providerUsed: LLMCompletionResult['provider'] | undefined;
  let modelUsed: string | undefined;
  let lastRawText = '';

  const callGateway = async (promptText: string): Promise<LLMCompletionResult> => {
    let result: LLMCompletionResult;
    try {
      result = await gateway.complete({
        prompt: promptText,
        systemPrompt: effectiveSystemPrompt,
        useCase: input.useCase,
        provider: input.provider,
        model: input.model,
        maxTokens: input.maxTokens,
        allowFallback: input.allowFallback,
        overrideTimeoutMs: input.overrideTimeoutMs,
        signal: input.signal,
      });
    } catch (error: unknown) {
      throw mapGatewayError(error, input.schemaName, input.allowFallback);
    }

    providerUsed = result.provider;
    modelUsed = result.model;
    totalInputTokens += result.usage.inputTokens;
    totalOutputTokens += result.usage.outputTokens;
    const { cost } = calculateCost(result.provider, result.model, result.usage.inputTokens, result.usage.outputTokens);
    totalCostUsd += cost;
    lastRawText = result.content;

    logger.info({
      type: 'ai_structured_completion_attempt',
      schemaName: input.schemaName,
      useCase: input.useCase,
      provider: result.provider,
      model: result.model,
      rawResponseHash: sha256Hex(result.content),
    });

    return result;
  };

  const buildResult = (data: T, validationAttempts: number): StructuredCompletionResult<T> => ({
    data,
    providerUsed: providerUsed!,
    modelUsed: modelUsed!,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    estimatedCostUsd: totalCostUsd,
    validationAttempts,
    rawResponseHash: sha256Hex(lastRawText),
  });

  const first = await callGateway(input.userPrompt);
  const firstParse = parseAgainstSchema(first.content, input.schema, input.schemaName);

  if (firstParse.success) {
    logger.info({ type: 'ai_structured_completion_success', schemaName: input.schemaName, validationAttempts: 1 });
    return buildResult(firstParse.data, 1);
  }

  logger.warn({
    type: 'ai_structured_completion_validation_failed',
    schemaName: input.schemaName,
    attempt: 1,
    issueCount: firstParse.issues.length,
  });

  if (correctionLimit < 1) {
    throw new AIStructuredOutputError(
      'SCHEMA_VALIDATION_FAILED',
      `Structured output for schema "${input.schemaName}" failed validation and no correction attempt was permitted.`,
      { schemaName: input.schemaName, issues: firstParse.issues },
    );
  }

  const correctionPrompt = [
    input.userPrompt,
    '',
    'Your previous response could not be parsed as valid JSON matching the required schema.',
    `Validation errors: ${JSON.stringify(firstParse.issues)}`,
    'Respond again with ONLY the corrected JSON object.',
  ].join('\n');

  const second = await callGateway(correctionPrompt);
  const secondParse = parseAgainstSchema(second.content, input.schema, input.schemaName);

  if (secondParse.success) {
    logger.info({ type: 'ai_structured_completion_success', schemaName: input.schemaName, validationAttempts: 2 });
    return buildResult(secondParse.data, 2);
  }

  logger.warn({
    type: 'ai_structured_completion_correction_failed',
    schemaName: input.schemaName,
    issueCount: secondParse.issues.length,
  });

  throw new AIStructuredOutputError(
    'SCHEMA_VALIDATION_FAILED',
    `Structured output for schema "${input.schemaName}" still failed validation after one correction attempt.`,
    { schemaName: input.schemaName, issues: secondParse.issues },
  );
}
