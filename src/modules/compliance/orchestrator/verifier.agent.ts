import { complete } from '@/lib/ai/client';
import { logger } from '@/utils/logger';
import { extractJson } from './utils';
import type { AgentTokens } from './types';
import type { SearchResult } from '@/lib/rag/rag.service';

export type VerifierVerdict = 'PASS' | 'PARTIAL' | 'FAIL';

export interface VerifierAgentResult {
  verdict: VerifierVerdict;
  unsupportedClaims: string[];
  tokens: AgentTokens;
  parseFailed: boolean;
}

const VALID_VERDICTS: VerifierVerdict[] = ['PASS', 'PARTIAL', 'FAIL'];

const SYSTEM = `You are a hallucination verifier for a Kenyan financial-services compliance RAG system.
Given an answer and the retrieved evidence used to generate it, assess grounding quality:
- PASS    : all substantive claims are supported by the evidence
- PARTIAL : most claims are supported, but some cannot be verified from the evidence
- FAIL    : significant claims are not supported by or contradict the evidence

Respond with a single JSON object:
{
  "verdict": "PASS"|"PARTIAL"|"FAIL",
  "unsupportedClaims": ["<brief description of unsupported claim 1>", "..."],
  "notes": "<one sentence summary>"
}

unsupportedClaims should list specific claims in the answer that cannot be traced to the evidence.
For a PASS verdict, unsupportedClaims should be an empty array [].
No markdown, no other text outside the JSON object.`;

export async function runVerifierAgent(
  answer: string,
  evidence: SearchResult[]
): Promise<VerifierAgentResult> {
  if (evidence.length === 0) {
    // No accepted chunks means there is no source-list basis for a legal answer.
    return {
      verdict: 'FAIL',
      unsupportedClaims: ['No graded evidence available to verify claims'],
      tokens: { input: 0, output: 0 },
      parseFailed: false,
    };
  }

  const evidenceText = evidence
    .slice(0, 5)
    .map((c, i) => `[${i + 1}] ${c.documentTitle}${c.section ? ` § ${c.section}` : ''}: ${c.chunkText.slice(0, 400)}`)
    .join('\n\n');

  const prompt = `Answer (first 800 chars):\n${answer.slice(0, 800)}\n\nEvidence:\n${evidenceText}`;

  try {
    const result = await complete(
      { prompt, systemPrompt: SYSTEM, maxTokens: 300, temperature: 0.0 },
      'query'
    );

    const tokens: AgentTokens = { input: result.inputTokens, output: result.outputTokens };

    try {
      const parsed = JSON.parse(extractJson(result.content)) as {
        verdict?: string;
        unsupportedClaims?: unknown[];
        notes?: string;
      };

      const candidate = parsed.verdict ?? '';
      const isValid = (VALID_VERDICTS as string[]).includes(candidate);
      const verdict: VerifierVerdict = isValid ? (candidate as VerifierVerdict) : 'PARTIAL';

      const unsupportedClaims = Array.isArray(parsed.unsupportedClaims)
        ? (parsed.unsupportedClaims as unknown[]).filter((c): c is string => typeof c === 'string')
        : [];

      logger.debug({
        type: 'verifier_agent_result',
        verdict,
        unsupportedClaimsCount: unsupportedClaims.length,
        notes: parsed.notes,
        parseFallback: !isValid,
      });

      return { verdict, unsupportedClaims, tokens, parseFailed: !isValid };
    } catch {
      logger.warn({ type: 'verifier_agent_parse_failed', contentSnippet: result.content.slice(0, 120) });
      return { verdict: 'PARTIAL', unsupportedClaims: [], tokens, parseFailed: true };
    }
  } catch (err: any) {
    logger.error({ type: 'verifier_agent_error', error: err?.message });
    return { verdict: 'PARTIAL', unsupportedClaims: [], tokens: { input: 0, output: 0 }, parseFailed: true };
  }
}
