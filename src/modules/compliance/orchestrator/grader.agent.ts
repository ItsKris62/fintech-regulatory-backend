import { createHash } from 'node:crypto';
import { z } from 'zod';
import { complete } from '@/lib/ai/client';
import { logger } from '@/utils/logger';
import type { AgentTokens } from './types';
import type { SearchResult } from '@/lib/rag/rag.service';
import { jurisdictionLabel, type JurisdictionContext } from '@/types/jurisdiction';
import { extractJsonCandidate } from '@/lib/ai/structured/extract-json';

export type GraderFailureClassification =
  | 'NONE'
  | 'EXTERNAL_PROVIDER_BILLING_BLOCKER'
  | 'GRADER_MODEL_ERROR'
  | 'GRADER_PARSE_ERROR'
  | 'GRADER_INCOMPLETE_OUTPUT'
  | 'GRADER_ZERO_RELEVANT'
  | 'GRADER_JURISDICTION_MISMATCH';

export interface GraderDiagnostics {
  questionHash: string;
  jurisdiction?: string;
  inputChunkCount: number;
  gradedChunkCount: number;
  acceptedCount: number;
  rejectedCount: number;
  rawResponseLength: number;
  parsedGradeCount: number;
  model?: string;
  provider?: string;
  stopReason?: string | null;
  maxTokens: number;
  gradeFailed: boolean;
  failureClassification: GraderFailureClassification;
  chunks: Array<{
    index: number;
    vectorId?: string;
    chunkId?: string;
    documentId?: string;
    documentTitle?: string;
    jurisdictionCode?: string;
    score?: number;
  }>;
  rawResponse?: string;
}

export interface GraderAgentResult {
  accepted: SearchResult[];
  rejected: SearchResult[];
  tokens: AgentTokens;
  gradeFailed: boolean;
  diagnostics?: GraderDiagnostics;
}

const GraderResponseSchema = z.object({
  grades: z.array(z.object({
    index: z.number().int().nonnegative(),
    relevant: z.boolean(),
  })),
});

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function classifyModelError(error: unknown): GraderFailureClassification {
  const message = error instanceof Error ? error.message : String(error);
  if (/credit balance is too low|purchase credits|billing|insufficient credit/i.test(message)) {
    return 'EXTERNAL_PROVIDER_BILLING_BLOCKER';
  }
  return 'GRADER_MODEL_ERROR';
}

function buildSystemPrompt(jurisdictionContext: JurisdictionContext): string {
  const label = jurisdictionContext.mode === 'SINGLE' ? jurisdictionLabel(jurisdictionContext.primaryJurisdiction) : jurisdictionContext.jurisdictions.map(jurisdictionLabel).join(', ');
  const jurisdictionString = jurisdictionContext.mode === 'SINGLE' ? jurisdictionContext.primaryJurisdiction : jurisdictionContext.jurisdictions.join(', ');
  return `You are a relevance grader for a ${label} financial-services compliance RAG system.
Active jurisdiction(s): ${label} (${jurisdictionString}).
Given a compliance question and retrieved document chunks, decide which chunks are relevant.
A chunk is relevant only if it belongs to one of the active jurisdictions and provides evidence that can help answer the question.

Mark relevant=true when the chunk provides any of:
- a direct legal requirement
- a relevant definition
- regulator authority or scope/applicability
- procedural requirement, exception, deadline, or penalty
- supporting legal context reasonably necessary to answer

A chunk does not need to contain the complete answer by itself. Reject chunks that are only topically similar, non-legal, stale, or from another jurisdiction.

Respond with a single JSON object:
{"grades":[{"index":0,"relevant":true},{"index":1,"relevant":false},...]}
One entry per chunk in order. No markdown, no other text.`;
}

function buildDiagnostics(input: {
  question: string;
  jurisdictionContext: JurisdictionContext;
  toGrade: SearchResult[];
  rawResponse?: string;
  parsedGradeCount?: number;
  accepted?: SearchResult[];
  rejected?: SearchResult[];
  result?: { model?: string; stopReason?: string | null };
  tokens?: AgentTokens;
  maxTokens: number;
  gradeFailed: boolean;
  failureClassification: GraderFailureClassification;
}): GraderDiagnostics {
  const acceptedCount = input.accepted?.length ?? 0;
  const rejectedCount = input.rejected?.length ?? input.toGrade.length;
  return {
    questionHash: sha256Hex(input.question.trim().toLowerCase()).slice(0, 16),
    jurisdiction: input.jurisdictionContext.mode === 'SINGLE' ? input.jurisdictionContext.primaryJurisdiction : undefined,
    inputChunkCount: input.toGrade.length,
    gradedChunkCount: input.toGrade.length,
    acceptedCount,
    rejectedCount,
    rawResponseLength: input.rawResponse?.length ?? 0,
    parsedGradeCount: input.parsedGradeCount ?? 0,
    model: input.result?.model,
    provider: input.result?.model ? 'anthropic' : undefined,
    stopReason: input.result?.stopReason,
    maxTokens: input.maxTokens,
    gradeFailed: input.gradeFailed,
    failureClassification: input.failureClassification,
    chunks: input.toGrade.map((chunk, index) => ({
      index,
      vectorId: chunk.vectorId,
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      documentTitle: chunk.documentTitle,
      jurisdictionCode: chunk.jurisdictionCode,
      score: chunk.score,
    })),
    rawResponse: input.rawResponse,
  };
}

export async function runGraderAgent(
  question: string,
  chunks: SearchResult[],
  jurisdictionContextOrMaxGradeChunks: JurisdictionContext | number,
  maxGradeChunksMaybe?: number
): Promise<GraderAgentResult> {
  const jurisdictionContext: JurisdictionContext = typeof jurisdictionContextOrMaxGradeChunks === 'number'
    ? {
        mode: 'SINGLE',
        jurisdictions: ['KE'],
        primaryJurisdiction: 'KE',
        jurisdictionSource: 'LEGACY_DEFAULT',
      }
    : jurisdictionContextOrMaxGradeChunks;
  const maxGradeChunks = typeof jurisdictionContextOrMaxGradeChunks === 'number'
    ? jurisdictionContextOrMaxGradeChunks
    : maxGradeChunksMaybe ?? 10;
  const toGrade = chunks.slice(0, maxGradeChunks);

  if (toGrade.length === 0) {
    return { accepted: [], rejected: [], tokens: { input: 0, output: 0 }, gradeFailed: false };
  }

  const chunkList = toGrade
    .map((c, i) => `[${i}] [${c.jurisdictionCode}] ${c.documentTitle}${c.section ? ` § ${c.section}` : ''}: ${c.chunkText.slice(0, 800)}`)
    .join('\n\n');

  const prompt = `Question: ${question}\n\nChunks:\n${chunkList}`;
  const maxTokens = Math.max(2048, 64 + toGrade.length * 35);

  try {
    const systemPrompt = buildSystemPrompt(jurisdictionContext);
    const result = await complete(
      { prompt, systemPrompt, maxTokens, temperature: 0.0 },
      'query'
    );

    const tokens: AgentTokens = { input: result.inputTokens, output: result.outputTokens };

    try {
      const jsonCandidate = extractJsonCandidate(result.content);
      if (!jsonCandidate) {
        throw new Error('No JSON object found in grader response.');
      }
      const parsed = GraderResponseSchema.parse(JSON.parse(jsonCandidate));
      const grades = parsed.grades;
      const accepted: SearchResult[] = [];
      const rejected: SearchResult[] = [];
      const gradedIndices = new Set<number>();
      let jurisdictionMismatchCount = 0;

      for (const grade of grades) {
        const chunk = toGrade[grade.index];
        if (!chunk) continue;
        gradedIndices.add(grade.index);
        if (grade.relevant && (jurisdictionContext.mode === 'SINGLE' ? chunk.jurisdictionCode === jurisdictionContext.primaryJurisdiction : jurisdictionContext.jurisdictions.includes(chunk.jurisdictionCode as any))) {
          accepted.push(chunk);
        } else if (grade.relevant) {
          jurisdictionMismatchCount++;
          rejected.push(chunk);
        } else {
          rejected.push(chunk);
        }
      }

      // Any chunk not graded is rejected. Phase 1B requires accepted sources
      // to be explicit, not inferred from parser truncation or model failure.
      for (let i = 0; i < toGrade.length; i++) {
        if (!gradedIndices.has(i)) rejected.push(toGrade[i]);
      }

      const failureClassification: GraderFailureClassification =
        jurisdictionMismatchCount > 0 ? 'GRADER_JURISDICTION_MISMATCH' :
        grades.length < toGrade.length || result.stopReason === 'max_tokens' ? 'GRADER_INCOMPLETE_OUTPUT' :
        accepted.length === 0 ? 'GRADER_ZERO_RELEVANT' :
        'NONE';
      const diagnostics = buildDiagnostics({
        question,
        jurisdictionContext,
        toGrade,
        rawResponse: result.content,
        parsedGradeCount: grades.length,
        accepted,
        rejected,
        result,
        tokens,
        maxTokens,
        gradeFailed: false,
        failureClassification,
      });

      logger.info({
        type: 'grader_agent_result',
        questionHash: diagnostics.questionHash,
        jurisdiction: diagnostics.jurisdiction,
        inputChunkCount: diagnostics.inputChunkCount,
        documentIds: diagnostics.chunks.map((chunk) => chunk.documentId),
        documentTitles: diagnostics.chunks.map((chunk) => chunk.documentTitle),
        vectorIds: diagnostics.chunks.map((chunk) => chunk.vectorId),
        model: diagnostics.model,
        provider: diagnostics.provider,
        rawResponseLength: diagnostics.rawResponseLength,
        parsedGradeCount: diagnostics.parsedGradeCount,
        acceptedCount: diagnostics.acceptedCount,
        rejectedCount: diagnostics.rejectedCount,
        gradeFailed: diagnostics.gradeFailed,
        failureClassification: diagnostics.failureClassification,
        stopReason: diagnostics.stopReason,
        maxTokens: diagnostics.maxTokens,
      });
      return { accepted, rejected, tokens, gradeFailed: false, diagnostics };
    } catch (error) {
      const diagnostics = buildDiagnostics({
        question,
        jurisdictionContext,
        toGrade,
        rawResponse: result.content,
        parsedGradeCount: 0,
        accepted: [],
        rejected: toGrade,
        result,
        tokens,
        maxTokens,
        gradeFailed: true,
        failureClassification: result.stopReason === 'max_tokens' ? 'GRADER_INCOMPLETE_OUTPUT' : 'GRADER_PARSE_ERROR',
      });
      logger.warn({
        type: 'grader_agent_parse_failed',
        questionHash: diagnostics.questionHash,
        jurisdiction: diagnostics.jurisdiction,
        inputChunkCount: diagnostics.inputChunkCount,
        rawResponseLength: diagnostics.rawResponseLength,
        parsedGradeCount: diagnostics.parsedGradeCount,
        acceptedCount: diagnostics.acceptedCount,
        rejectedCount: diagnostics.rejectedCount,
        gradeFailed: diagnostics.gradeFailed,
        failureClassification: diagnostics.failureClassification,
        stopReason: diagnostics.stopReason,
        maxTokens: diagnostics.maxTokens,
        error: error instanceof Error ? error.message : String(error),
      });
      return { accepted: [], rejected: toGrade, tokens, gradeFailed: true, diagnostics };
    }
  } catch (err: any) {
    const diagnostics = buildDiagnostics({
      question,
      jurisdictionContext,
      toGrade,
      maxTokens,
      gradeFailed: true,
      failureClassification: classifyModelError(err),
    });
    logger.error({
      type: 'grader_agent_error',
      questionHash: diagnostics.questionHash,
      jurisdiction: diagnostics.jurisdiction,
      inputChunkCount: diagnostics.inputChunkCount,
      acceptedCount: diagnostics.acceptedCount,
      rejectedCount: diagnostics.rejectedCount,
      gradeFailed: diagnostics.gradeFailed,
      failureClassification: diagnostics.failureClassification,
      maxTokens: diagnostics.maxTokens,
      error: err?.message,
    });
    return { accepted: [], rejected: toGrade, tokens: { input: 0, output: 0 }, gradeFailed: true, diagnostics };
  }
}
