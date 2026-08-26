import { randomUUID } from 'node:crypto';
import {
  ragService,
  searchAndGetRegulatoryEvidenceContext,
  type SearchResult,
} from '@/lib/rag/rag.service';
import {
  buildCitationsFromChunks,
  hasUsableCitations,
  validateCitationsForJurisdiction,
  type SourceCitation,
} from '@/lib/source-grounding/citations';
import type { ComplianceFallbackReason } from '@/lib/source-grounding/source-insufficiency';
import { runGraderAgent } from '@/modules/compliance/orchestrator/grader.agent';
import type { GraderFailureClassification } from '@/modules/compliance/orchestrator/grader.agent';
import type { JurisdictionContext } from '@/types/jurisdiction';
import { logger } from '@/utils/logger';

export type RegulatoryIntelligenceFeature =
  | 'COMPLIANCE_QUERY'
  | 'FOLLOW_UP'
  | 'QUICK_CHECK'
  | 'GAP_ANALYSIS'
  | 'CHECKLIST'
  | 'POLICY'
  | 'ROADMAP'
  | 'RECOMMENDATION'
  | 'CUSTOM_FRAMEWORK'
  | 'POLICY_CITATION_VERIFICATION';

export type RegulatoryFailureClassification =
  | ComplianceFallbackReason
  | GraderFailureClassification
  | 'RAG_NO_EVIDENCE'
  | 'RAG_CORPUS_GAP'
  | 'GRADER_REJECTED_ALL'
  | 'ANTHROPIC_BILLING_BLOCKED'
  | 'ANTHROPIC_RATE_LIMIT'
  | 'ANTHROPIC_AUTH_FAILURE'
  | 'ANTHROPIC_OVERLOADED'
  | 'VERIFIER_PARTIAL'
  | 'VERIFIER_FAIL';

export interface RegulatoryIntelligenceRequest {
  question: string;
  feature: RegulatoryIntelligenceFeature;
  jurisdictionContext: JurisdictionContext;
  organizationContext?: {
    organizationId: string;
    organizationType?: string;
    industry?: string;
  };
  retrievalProfile?: {
    topK?: number;
    minScore?: number;
    filter?: Record<string, unknown>;
    sourceIndexMode?: 'v1' | 'v2' | 'prefer-v2';
  };
  generationProfile?: string;
  runId?: string;
  effectivePlan?: string;
  mode?: JurisdictionContext['mode'];
}

export interface RegulatoryIntelligenceResult {
  runId: string;
  grounded: boolean;
  evidence: SearchResult[];
  rejectedEvidence: SearchResult[];
  citations: SourceCitation[];
  verifierVerdict: 'PASS' | 'PARTIAL' | 'FAIL';
  unsupportedClaims: string[];
  abstained: boolean;
  failureReason?: RegulatoryFailureClassification;
  retrievedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  corpusVersionSnapshot: Record<string, string | undefined>;
  retrievalVersion: string;
  acceptedContext: string;
  diagnostics?: Record<string, unknown>;
}

function classifyNoAcceptedEvidence(graderFailure?: GraderFailureClassification): RegulatoryFailureClassification {
  if (graderFailure && graderFailure !== 'NONE') return graderFailure;
  return 'GRADER_REJECTED_ALL';
}

export class RegulatoryIntelligenceService {
  async retrieveAndGrade(input: RegulatoryIntelligenceRequest): Promise<RegulatoryIntelligenceResult> {
    const runId = input.runId ?? randomUUID();
    const startedAt = Date.now();
    const topK = input.retrievalProfile?.topK ?? 10;
    const minScore = input.retrievalProfile?.minScore ?? 0.7;

    logger.info({
      type: 'regulatory_intelligence_start',
      feature: input.feature,
      runId,
      orgId: input.organizationContext?.organizationId,
      effectivePlan: input.effectivePlan,
      requestedJurisdictions: [...input.jurisdictionContext.jurisdictions],
      mode: input.jurisdictionContext.mode,
    });

    const ragContext = await searchAndGetRegulatoryEvidenceContext({
      query: input.question,
      jurisdictionContext: input.jurisdictionContext,
      topK,
      minScore,
      filter: input.retrievalProfile?.filter,
      preferActiveSources: true,
      sourceIndexMode: input.retrievalProfile?.sourceIndexMode,
    });

    if (!ragContext.context || ragContext.results.length === 0) {
      const result: RegulatoryIntelligenceResult = {
        runId,
        grounded: false,
        evidence: [],
        rejectedEvidence: [],
        citations: [],
        verifierVerdict: 'FAIL',
        unsupportedClaims: [],
        abstained: true,
        failureReason: ragContext.results.length === 0 ? 'RAG_NO_EVIDENCE' : 'RAG_CORPUS_GAP',
        retrievedCount: ragContext.results.length,
        acceptedCount: 0,
        rejectedCount: 0,
        corpusVersionSnapshot: ragContext.corpusVersions,
        retrievalVersion: ragContext.retrievalVersion,
        acceptedContext: '',
      };
      this.logComplete(input, result, startedAt);
      return result;
    }

    const grade = await runGraderAgent(input.question, ragContext.results, input.jurisdictionContext, topK);
    const acceptedContext = ragService.getContextForPrompt(grade.accepted, topK, 4000);
    const citations = buildCitationsFromChunks(grade.accepted, 'verified');
    const citationValidation = validateCitationsForJurisdiction(citations, input.jurisdictionContext);
    const grounded = hasUsableCitations(citations) && citationValidation.valid && grade.accepted.length > 0;
    const abstained = !grounded || !acceptedContext;

    const result: RegulatoryIntelligenceResult = {
      runId,
      grounded,
      evidence: grounded ? grade.accepted : [],
      rejectedEvidence: grade.rejected,
      citations: grounded ? citations : [],
      verifierVerdict: grounded ? 'PASS' : 'FAIL',
      unsupportedClaims: [],
      abstained,
      failureReason: abstained
        ? classifyNoAcceptedEvidence(grade.diagnostics?.failureClassification)
        : undefined,
      retrievedCount: ragContext.results.length,
      acceptedCount: grounded ? grade.accepted.length : 0,
      rejectedCount: grade.rejected.length,
      corpusVersionSnapshot: ragContext.corpusVersions,
      retrievalVersion: ragContext.retrievalVersion,
      acceptedContext: grounded ? acceptedContext : '',
      diagnostics: {
        graderFailed: grade.gradeFailed,
        graderFailureClassification: grade.diagnostics?.failureClassification,
        citationJurisdictionValid: citationValidation.valid,
        citationJurisdictionInvalidCount: citationValidation.invalidCitations.length,
      },
    };
    this.logComplete(input, result, startedAt);
    return result;
  }

  private logComplete(
    input: RegulatoryIntelligenceRequest,
    result: RegulatoryIntelligenceResult,
    startedAt: number,
  ): void {
    logger.info({
      type: 'regulatory_intelligence_complete',
      feature: input.feature,
      runId: result.runId,
      orgId: input.organizationContext?.organizationId,
      effectivePlan: input.effectivePlan,
      requestedJurisdictions: [...input.jurisdictionContext.jurisdictions],
      allowedJurisdictions: [...input.jurisdictionContext.jurisdictions],
      mode: input.jurisdictionContext.mode,
      retrievedCount: result.retrievedCount,
      acceptedCount: result.acceptedCount,
      rejectedCount: result.rejectedCount,
      verifierVerdict: result.verifierVerdict,
      abstained: result.abstained,
      failureClassification: result.failureReason,
      latencyMs: Date.now() - startedAt,
    });
  }
}

export const regulatoryIntelligenceService = new RegulatoryIntelligenceService();
