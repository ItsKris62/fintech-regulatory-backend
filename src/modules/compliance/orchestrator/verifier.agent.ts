import { complete } from '@/lib/ai/client';
import { logger } from '@/utils/logger';
import { extractJson } from './utils';
import type { AgentTokens } from './types';
import type { SearchResult } from '@/lib/rag/rag.service';
import { jurisdictionLabel, type JurisdictionContext, type JurisdictionCode } from '@/types/jurisdiction';
import type {
  RegulatoryEvidenceRef,
  PolicyEvidenceRef,
} from '@/modules/compliance/scoring/gap-analysis-scoring';

export type VerifierVerdict = 'PASS' | 'PARTIAL' | 'FAIL';

export interface VerifierAgentResult {
  verdict: VerifierVerdict;
  unsupportedClaims: string[];
  tokens: AgentTokens;
  parseFailed: boolean;
}

const VALID_VERDICTS: VerifierVerdict[] = ['PASS', 'PARTIAL', 'FAIL'];

function buildSystemPrompt(jurisdictionContext: JurisdictionContext): string {
  const label = jurisdictionContext.mode === 'SINGLE' ? jurisdictionLabel(jurisdictionContext.primaryJurisdiction) : jurisdictionContext.jurisdictions.map(jurisdictionLabel).join(', ');
  return `You are a hallucination verifier for a ${label} financial-services compliance RAG system.
Active jurisdiction: ${label} (${jurisdictionContext.mode === 'SINGLE' ? jurisdictionContext.primaryJurisdiction : jurisdictionContext.jurisdictions.join(', ')}).
Given an answer and the retrieved evidence used to generate it, assess grounding quality:
- PASS    : all substantive claims are supported by the evidence
- PARTIAL : most claims are supported, but some cannot be verified from the evidence
- FAIL    : significant claims are not supported by or contradict the evidence

Treat any legal claim or citation attributed to a jurisdiction that is not supported by evidence from that specific jurisdiction as unsupported.

Respond with a single JSON object:
{
  "verdict": "PASS"|"PARTIAL"|"FAIL",
  "unsupportedClaims": ["<brief description of unsupported claim 1>", "..."],
  "notes": "<one sentence summary>"
}

unsupportedClaims should list specific claims in the answer that cannot be traced to the evidence.
For a PASS verdict, unsupportedClaims should be an empty array [].
No markdown, no other text outside the JSON object.`;
}

export async function runVerifierAgent(
  answer: string,
  evidence: SearchResult[],
  jurisdictionContext: JurisdictionContext,
  signal?: AbortSignal,
): Promise<VerifierAgentResult> {
  if (evidence.length === 0) {
    return {
      verdict: 'FAIL',
      unsupportedClaims: ['No graded evidence available to verify claims'],
      tokens: { input: 0, output: 0 },
      parseFailed: false,
    };
  }

  const evidenceText = evidence
    .slice(0, 5)
    .map((c, i) => `[${i + 1}] [${c.jurisdictionCode}] ${c.documentTitle}${c.section ? ` § ${c.section}` : ''}: ${c.chunkText.slice(0, 400)}`)
    .join('\n\n');

  const prompt = `Answer (first 800 chars):\n${answer.slice(0, 800)}\n\nEvidence:\n${evidenceText}`;

  try {
    const systemPrompt = buildSystemPrompt(jurisdictionContext);
    const result = await complete(
      { prompt, systemPrompt, maxTokens: 2048, temperature: 0.0, signal },
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
    if (signal?.aborted) throw signal.reason ?? err;
    logger.error({ type: 'verifier_agent_error', error: err?.message });
    return { verdict: 'PARTIAL', unsupportedClaims: [], tokens: { input: 0, output: 0 }, parseFailed: true };
  }
}

// ─── CLAIM-LEVEL VERIFICATION FOR GAP FINDINGS (GA-04) ────────────────────────

export interface FindingVerificationInput {
  id: string;
  title?: string;
  requirement: string;
  status: 'COMPLIANT' | 'PARTIAL' | 'GAP' | 'NOT_ASSESSED' | 'INSUFFICIENT_EVIDENCE';
  severity: string;
  severityRationale?: string;
  regulatoryBasis: string;
  policyCurrentState: string;
  regulatoryEvidence: RegulatoryEvidenceRef[];
  policyEvidence: PolicyEvidenceRef[];
  frameworkSlug: string;
  jurisdiction: JurisdictionCode;
  requestedEvidenceIds?: string[];
  resolvedEvidenceIds?: string[];
  invalidEvidenceIds?: string[];
  requestedPolicyEvidenceIds?: string[];
  resolvedPolicyEvidenceIds?: string[];
  invalidPolicyEvidenceIds?: string[];
}

export interface FindingVerificationVerdict {
  findingId: string;
  verdict: 'SUPPORTED' | 'PARTIALLY_SUPPORTED' | 'UNSUPPORTED' | 'NOT_VERIFIABLE';
  confidence: number;
  unsupportedClaims: string[];
  reason?: string;
}

/**
 * Claim-level verification for Gap Analysis findings.
 * Evaluates each finding independently against its associated regulatory and policy evidence.
 *
 * Rules:
 * 1. Hallucinated / invalid evidence IDs -> UNSUPPORTED.
 * 2. Missing regulatory evidence -> NOT_VERIFIABLE.
 * 3. Regulatory evidence from another jurisdiction or unrelated framework -> UNSUPPORTED.
 * 4. COMPLIANT or PARTIAL status with empty policy evidence -> UNSUPPORTED.
 * 5. Grounded regulatory basis matching the authorized requirement -> SUPPORTED.
 */
export function verifyFindingClaims(
  findings: FindingVerificationInput[],
  analysisJurisdiction: JurisdictionCode,
): FindingVerificationVerdict[] {
  return findings.map((f) => {
    // 0a. Model cited invalid/hallucinated regulatory evidence ID(s)
    if (f.invalidEvidenceIds && f.invalidEvidenceIds.length > 0) {
      return {
        findingId: f.id,
        verdict: 'UNSUPPORTED',
        confidence: 0.1,
        unsupportedClaims: [
          `Model cited invalid or unresolvable regulatory evidence ID(s): ${f.invalidEvidenceIds.join(', ')}`,
        ],
        reason: 'Invalid or hallucinated regulatory evidence citation',
      };
    }

    // 0b. Model cited invalid/hallucinated customer policy evidence ID(s)
    if (f.invalidPolicyEvidenceIds && f.invalidPolicyEvidenceIds.length > 0) {
      return {
        findingId: f.id,
        verdict: 'UNSUPPORTED',
        confidence: 0.1,
        unsupportedClaims: [
          `Model cited invalid or unresolvable policy evidence ID(s): ${f.invalidPolicyEvidenceIds.join(', ')}`,
        ],
        reason: 'Invalid or hallucinated policy evidence citation',
      };
    }

    // 1. Missing regulatory evidence
    if (!f.regulatoryEvidence || f.regulatoryEvidence.length === 0) {
      if (f.status === 'INSUFFICIENT_EVIDENCE') {
        return {
          findingId: f.id,
          verdict: 'NOT_VERIFIABLE',
          confidence: 0.5,
          unsupportedClaims: [],
          reason: 'No approved regulatory evidence available (coverage limitation)',
        };
      }
      return {
        findingId: f.id,
        verdict: 'NOT_VERIFIABLE',
        confidence: 0.2,
        unsupportedClaims: [`No approved regulatory evidence cited for requirement: ${f.requirement || f.title || f.id}`],
        reason: 'Missing regulatory evidence basis',
      };
    }

    // 2. Cross-border / foreign jurisdiction check
    const foreignJurisdictionEvidence = f.regulatoryEvidence.filter(
      (r) =>
        r.jurisdiction !== analysisJurisdiction &&
        r.jurisdiction !== 'GLOBAL' &&
        r.jurisdiction !== 'INTERNATIONAL',
    );
    if (foreignJurisdictionEvidence.length > 0) {
      return {
        findingId: f.id,
        verdict: 'UNSUPPORTED',
        confidence: 0.2,
        unsupportedClaims: [
          `Regulatory evidence cited from foreign jurisdiction (${foreignJurisdictionEvidence.map((e) => e.jurisdiction).join(', ')})`,
        ],
        reason: 'Cross-border evidence violation',
      };
    }

    // 3. Cross-framework check
    const frameworkMismatchEvidence = f.regulatoryEvidence.filter(
      (r) => r.frameworkSlug && f.frameworkSlug && r.frameworkSlug !== f.frameworkSlug,
    );
    if (frameworkMismatchEvidence.length > 0) {
      return {
        findingId: f.id,
        verdict: 'UNSUPPORTED',
        confidence: 0.2,
        unsupportedClaims: [
          `Regulatory evidence cited from unrelated framework (${frameworkMismatchEvidence.map((e) => e.frameworkSlug).join(', ')})`,
        ],
        reason: 'Cross-framework citation violation',
      };
    }

    // 4. Policy evidence check for positive claims
    if (f.status === 'COMPLIANT' || f.status === 'PARTIAL') {
      if (!f.policyEvidence || f.policyEvidence.length === 0) {
        return {
          findingId: f.id,
          verdict: 'UNSUPPORTED',
          confidence: 0.3,
          unsupportedClaims: ['Claimed compliance or partial alignment without policy evidence'],
          reason: 'Missing customer policy evidence for positive claim',
        };
      }
    }

    // 5. Lexical / semantic basis grounding check
    const requirementText = `${f.requirement} ${f.regulatoryBasis}`.toLowerCase();
    const evidenceExcerpts = f.regulatoryEvidence.map((r) => r.excerpt.toLowerCase()).join(' ');

    const keyTerms = requirementText
      .split(/[\s,.;:()"-]+/)
      .filter((t) => t.length > 4 && !['shall', 'their', 'under', 'section', 'regulation', 'policy', 'which'].includes(t));

    const matchingTerms = keyTerms.filter((term) => evidenceExcerpts.includes(term));
    const matchRatio = keyTerms.length > 0 ? matchingTerms.length / keyTerms.length : 1.0;

    if (matchRatio >= 0.3) {
      return {
        findingId: f.id,
        verdict: 'SUPPORTED',
        confidence: 0.95,
        unsupportedClaims: [],
        reason: 'Substantive regulatory and policy evidence verified',
      };
    }

    return {
      findingId: f.id,
      verdict: 'PARTIALLY_SUPPORTED',
      confidence: 0.7,
      unsupportedClaims: ['Regulatory excerpt provides partial grounding for requirement specifics'],
      reason: 'Partial lexical alignment between requirement and regulatory excerpt',
    };
  });
}

export interface EvidenceResolutionResult {
  regulatoryEvidence: RegulatoryEvidenceRef[];
  requestedEvidenceIds: string[];
  resolvedEvidenceIds: string[];
  invalidEvidenceIds: string[];
  policyEvidence: PolicyEvidenceRef[];
  requestedPolicyEvidenceIds: string[];
  resolvedPolicyEvidenceIds: string[];
  invalidPolicyEvidenceIds: string[];
}

/**
 * Strict, deterministic evidence resolution for gap findings.
 * Enforces Batch 3.1 rules:
 * - A finding may reference regulatory evidence ONLY if explicitly cited and validated.
 * - A finding may reference policy evidence ONLY if explicitly cited and matched to current upload.
 * - NO fallback to first chunk of framework or document.
 */
export function resolveFindingEvidence(params: {
  citedEvidenceIds?: string[];
  citedPolicyEvidenceIds?: string[];
  frameworkSlug: string;
  frameworkName?: string;
  analysisJurisdiction: JurisdictionCode;
  acceptedEvidenceMap: Map<string, RegulatoryEvidenceRef>;
  policyEvidenceMap: Map<string, PolicyEvidenceRef>;
}): EvidenceResolutionResult {
  const citedEvidenceIds = params.citedEvidenceIds ?? [];
  const requestedEvidenceIds = [...citedEvidenceIds];
  const resolvedEvidenceIds: string[] = [];
  const invalidEvidenceIds: string[] = [];
  const resolvedRegulatory: RegulatoryEvidenceRef[] = [];

  for (const eId of citedEvidenceIds) {
    const found = params.acceptedEvidenceMap.get(eId);
    if (!found) {
      invalidEvidenceIds.push(eId);
      continue;
    }

    // Framework compatibility
    const fwMatches =
      !found.frameworkSlug ||
      !params.frameworkSlug ||
      found.frameworkSlug === params.frameworkSlug ||
      (params.frameworkName && params.frameworkName.includes(found.frameworkSlug)) ||
      params.frameworkSlug.includes(found.frameworkSlug);

    // Jurisdiction compatibility
    const jurMatches =
      !found.jurisdiction ||
      found.jurisdiction === params.analysisJurisdiction ||
      found.jurisdiction === 'GLOBAL' ||
      found.jurisdiction === 'INTERNATIONAL';

    if (fwMatches && jurMatches) {
      resolvedRegulatory.push(found);
      resolvedEvidenceIds.push(eId);
    } else {
      invalidEvidenceIds.push(eId);
    }
  }

  const citedPolIds = params.citedPolicyEvidenceIds ?? [];
  const requestedPolicyEvidenceIds = [...citedPolIds];
  const resolvedPolicyEvidenceIds: string[] = [];
  const invalidPolicyEvidenceIds: string[] = [];
  const resolvedPolicy: PolicyEvidenceRef[] = [];

  for (const pId of citedPolIds) {
    const found = params.policyEvidenceMap.get(pId);
    if (found) {
      resolvedPolicy.push(found);
      resolvedPolicyEvidenceIds.push(pId);
    } else {
      invalidPolicyEvidenceIds.push(pId);
    }
  }

  return {
    regulatoryEvidence: resolvedRegulatory,
    requestedEvidenceIds,
    resolvedEvidenceIds,
    invalidEvidenceIds,
    policyEvidence: resolvedPolicy,
    requestedPolicyEvidenceIds,
    resolvedPolicyEvidenceIds,
    invalidPolicyEvidenceIds,
  };
}
