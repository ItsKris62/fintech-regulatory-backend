import { complete } from '@/lib/ai/client';
import { logger } from '@/utils/logger';
import { extractJson } from './utils';
import type { AgentTokens } from './types';
import type { SearchResult } from '@/lib/rag/rag.service';
import { jurisdictionLabel, type JurisdictionContext } from '@/types/jurisdiction';

export interface GraderAgentResult {
  accepted: SearchResult[];
  rejected: SearchResult[];
  tokens: AgentTokens;
  gradeFailed: boolean;
}

function buildSystemPrompt(jurisdictionContext: JurisdictionContext): string {
  const label = jurisdictionLabel(jurisdictionContext.primaryJurisdiction);
  return `You are a relevance grader for a ${label} financial-services compliance RAG system.
Active jurisdiction: ${label} (${jurisdictionContext.primaryJurisdiction}).
Given a compliance question and retrieved document chunks, decide which chunks are relevant.
A chunk is relevant only if it contains information that directly helps answer the question and belongs to the active jurisdiction.

Respond with a single JSON object:
{"grades":[{"index":0,"relevant":true},{"index":1,"relevant":false},...]}
One entry per chunk in order. No markdown, no other text.`;
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
    .map((c, i) => `[${i}] ${c.documentTitle}${c.section ? ` § ${c.section}` : ''}: ${c.chunkText.slice(0, 800)}`)
    .join('\n\n');

  const prompt = `Question: ${question}\n\nChunks:\n${chunkList}`;
  const maxTokens = Math.max(60, 20 + toGrade.length * 15);

  try {
    const systemPrompt = buildSystemPrompt(jurisdictionContext);
    const result = await complete(
      { prompt, systemPrompt, maxTokens, temperature: 0.0 },
      'query'
    );

    const tokens: AgentTokens = { input: result.inputTokens, output: result.outputTokens };

    try {
      const parsed = JSON.parse(extractJson(result.content)) as { grades?: Array<{ index: number; relevant: boolean }> };
      const grades = parsed.grades ?? [];
      const accepted: SearchResult[] = [];
      const rejected: SearchResult[] = [];
      const gradedIndices = new Set<number>();

      for (const grade of grades) {
        const chunk = toGrade[grade.index];
        if (!chunk) continue;
        gradedIndices.add(grade.index);
        if (grade.relevant) {
          accepted.push(chunk);
        } else {
          rejected.push(chunk);
        }
      }

      // Any chunk not graded is rejected. Phase 1B requires accepted sources
      // to be explicit, not inferred from parser truncation or model failure.
      for (let i = 0; i < toGrade.length; i++) {
        if (!gradedIndices.has(i)) rejected.push(toGrade[i]);
      }

      logger.debug({ type: 'grader_agent_result', accepted: accepted.length, rejected: rejected.length });
      return { accepted, rejected, tokens, gradeFailed: false };
    } catch {
      logger.warn({ type: 'grader_agent_parse_failed', contentSnippet: result.content.slice(0, 120) });
      return { accepted: [], rejected: toGrade, tokens, gradeFailed: true };
    }
  } catch (err: any) {
    logger.error({ type: 'grader_agent_error', error: err?.message });
    return { accepted: [], rejected: toGrade, tokens: { input: 0, output: 0 }, gradeFailed: true };
  }
}
