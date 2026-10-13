/**
 * Gap Analysis Generation Prompts
 * AI prompts for comparing uploaded policy documents against
 * jurisdiction-scoped regulatory requirements using RAG-retrieved context.
 */

import { z } from 'zod';
import { jurisdictionLabel, type JurisdictionContext } from '@/types/jurisdiction';
import {
  calculateComplianceAlignmentScore,
  SCORING_VERSION_V2,
  type RequirementAssessment,
  type DocumentCoverage,
} from '@/modules/compliance/scoring/gap-analysis-scoring';

export type { JurisdictionContext };

// --- Input Types -------------------------------------------------------------

export interface GapAnalysisParams {
  policyText: string;
  documentName: string;
  documentType: string;
  regulatoryFrameworks: string[];
  benchmarkDocumentIds?: string[];
  analysisDepth: 'quick' | 'standard' | 'deep';
  focusAreas?: string[];
  ragContext?: string; // Retrieved regulatory passages from Pinecone with EVIDENCE_ID
  jurisdictionContext?: JurisdictionContext;
  signal?: AbortSignal;
  beforeAiOperation?: (plan?: GapAnalysisModelCallPlan) => Promise<void>;
}

export interface GapAnalysisModelCallPlan {
  stage: 'analysis' | 'merge' | 'enhanced_review' | 'verification';
  estimatedInputTokens: number;
  maxOutputTokens: number;
}

export interface BenchmarkDocumentSummary {
  id: string;
  title: string;
  documentType?: string | null;
  regulatoryBody?: string | null;
}

// ─── STABLE EVIDENCE REFERENCE SCHEMAS ───────────────────────────────────────

export const RegulatoryEvidenceRefSchema = z.object({
  evidenceId: z.string(),
  vectorId: z.string(),
  documentId: z.string().nullable().optional(),
  documentTitle: z.string(),
  jurisdiction: z.union([z.enum(['KE', 'RW', 'MW', 'NG']), z.literal('GLOBAL'), z.literal('INTERNATIONAL')]),
  frameworkSlug: z.string(),
  sourceAuthority: z.string().optional(),
  section: z.string().optional(),
  page: z.number().optional(),
  effectiveDate: z.string().optional(),
  sourceStatus: z.string().optional(),
  excerpt: z.string(),
  similarityScore: z.number().optional(),
  rerankScore: z.number().optional(),
});

export const PolicyEvidenceRefSchema = z.object({
  policyEvidenceId: z.string(),
  chunkIndex: z.number().optional(),
  page: z.number().optional(),
  sectionHeading: z.string().optional(),
  excerpt: z.string(),
  startOffset: z.number().optional(),
  endOffset: z.number().optional(),
});

export const FindingVerificationSchema = z.object({
  verdict: z.enum(['SUPPORTED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'NOT_VERIFIABLE']),
  confidence: z.number().optional(),
  unsupportedClaims: z.array(z.string()).optional(),
  reason: z.string().optional(),
});

export const FindingCoverageSchema = z.object({
  regulatoryEvidenceAvailable: z.boolean().default(true),
  policySectionAssessed: z.boolean().default(true),
  extractionComplete: z.boolean().default(true),
});

export const DocumentCoverageSchema = z.object({
  totalChunks: z.number().int().min(0),
  processedChunks: z.number().int().min(0),
  failedChunks: z.number().int().min(0),
  skippedChunks: z.number().int().min(0),
  extractionComplete: z.boolean(),
});

export const FrameworkCoverageSchema = z.object({
  frameworkSlug: z.string(),
  evidenceStatus: z.enum(['COMPLETE', 'PARTIAL', 'INSUFFICIENT', 'UNAVAILABLE']),
  assessedRequirementCount: z.number().int().min(0),
  totalKnownRequirementCount: z.number().int().min(0).optional(),
  unassessedRequirementCount: z.number().int().min(0).optional(),
  notes: z.array(z.string()).optional(),
});

// --- Zod Validation Schemas + Inferred Types ---------------------------------

export const GapItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  requirement: z.string().optional().default(''),
  frameworkSlug: z.string().optional(),
  jurisdiction: z.enum(['KE', 'RW', 'MW', 'NG']).optional(),
  status: z.enum(['COMPLIANT', 'PARTIAL', 'GAP', 'NOT_ASSESSED', 'INSUFFICIENT_EVIDENCE']).default('GAP'),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']),
  severityRationale: z.string().optional().default(''),
  regulatoryBasis: z.string(),
  description: z.string(),
  policyCurrentState: z.string(),
  recommendation: z.string(),
  effort: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  priority: z.number().int().min(1),
  /** Evidence IDs cited by LLM from retrieved regulatory context */
  evidenceIds: z.array(z.string()).default([]),
  /** Requested regulatory evidence IDs from model output */
  requestedEvidenceIds: z.array(z.string()).default([]),
  /** Resolved verified regulatory evidence IDs */
  resolvedEvidenceIds: z.array(z.string()).default([]),
  /** Rejected / unresolvable / invalid regulatory evidence IDs */
  invalidEvidenceIds: z.array(z.string()).default([]),
  /** Policy chunk/section IDs cited by LLM from uploaded policy */
  policyEvidenceIds: z.array(z.string()).default([]),
  /** Requested customer policy chunk IDs from model output */
  requestedPolicyEvidenceIds: z.array(z.string()).default([]),
  /** Resolved customer policy chunk IDs */
  resolvedPolicyEvidenceIds: z.array(z.string()).default([]),
  /** Rejected / unresolvable / invalid customer policy chunk IDs */
  invalidPolicyEvidenceIds: z.array(z.string()).default([]),
  /** Deterministic joined regulatory evidence */
  regulatoryEvidence: z.array(RegulatoryEvidenceRefSchema).default([]),
  /** Deterministic joined customer policy evidence */
  policyEvidence: z.array(PolicyEvidenceRefSchema).default([]),
  /** Claim-level verification results */
  verification: FindingVerificationSchema.default({ verdict: 'NOT_VERIFIABLE' }),
  /** Finding coverage metrics */
  coverage: FindingCoverageSchema.default({ regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true }),
  /** Documents/artefacts that must be produced to close this gap. */
  evidenceRequired: z.array(z.string()).default([]),
  /** Role accountable for resolving this gap. */
  responsibleRole: z.string().optional(),
  /** Regulatory deadline if the regulation specifies one. */
  regulatoryDeadline: z.string().optional(),
  /** Post-hoc verification: true if regulatoryBasis was found in the legal corpus. */
  citationVerified: z.boolean().optional(),
  verificationStatus: z.enum(['verified', 'unverified', 'not_checked']).optional(),
  sourceDocumentTitle: z.string().optional(),
  sourceSection: z.string().optional(),
  sourceSnippet: z.string().optional(),
  authorityStatus: z.string().optional(),
  isBinding: z.boolean().optional(),
});

export const FrameworkResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  score: z.number().min(0).max(100),
  gaps: z.array(GapItemSchema),
  strengths: z.array(z.string()),
  summary: z.string(),
});

export const ActionPlanItemSchema = z.object({
  priority: z.number().int().min(1),
  action: z.string(),
  framework: z.string(),
  deadline: z.string(),
  effort: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  resources: z.array(z.string()),
  dependsOn: z.array(z.union([z.string(), z.number().transform((n) => String(n))])).default([]),
  /** Role accountable for delivering this action. */
  responsibleRole: z.string().optional(),
});

export const GapAnalysisResultSchema = z.object({
  overallScore: z.number().min(0).max(100),
  assessmentCoverage: z.number().min(0).max(100).default(100),
  executiveSummary: z.string(),
  frameworks: z.array(FrameworkResultSchema).min(1),
  crossCuttingStrengths: z.array(z.string()),
  actionPlan: z.array(ActionPlanItemSchema),
  metadata: z.object({
    documentName: z.string(),
    analysisDepth: z.string(),
    frameworksAnalysed: z.array(z.string()),
    totalGaps: z.number().int().min(0),
    criticalGaps: z.number().int().min(0),
    highGaps: z.number().int().min(0),
    mediumGaps: z.number().int().min(0).optional(),
    lowGaps: z.number().int().min(0).optional(),
    analysisDate: z.string(),
    calculatedScore: z.number().min(0).max(100).optional(),
    complianceAlignmentScore: z.number().min(0).max(100).optional(),
    assessmentCoverageScore: z.number().min(0).max(100).optional(),
    coverageStatus: z.enum(['COMPLETE', 'PARTIAL', 'INSUFFICIENT']).default('COMPLETE'),
    scoringVersion: z.string().optional(),
    modelSuggestedScore: z.number().min(0).max(100).optional(),
    documentCoverage: DocumentCoverageSchema.optional(),
    frameworkCoverage: z.record(z.string(), FrameworkCoverageSchema).optional(),
    selectedBenchmarkDocuments: z.array(
      z.union([
        z.string().transform((title) => ({ id: title, title, documentType: null, regulatoryBody: null })),
        z.object({
          id: z.string().optional().default(''),
          title: z.string(),
          documentType: z.string().nullable().optional(),
          regulatoryBody: z.string().nullable().optional(),
        }),
      ])
    ).default([]),
    chunksProcessed: z.number().int().positive().optional(),
    tokenCost: z.object({
      provider: z.string().optional(),
      model: z.string().optional(),
      callCount: z.number().int().min(0).optional(),
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
      estimatedCostUsd: z.number().min(0).optional(),
      costType: z.enum(['MEASURED', 'ESTIMATED', 'NOT_VERIFIED']).optional(),
    }).optional(),
    costAccounting: z.object({
      provider: z.string(),
      model: z.string(),
      callCount: z.number().int().min(0).optional(),
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
      durationMs: z.number().int().min(0),
      costType: z.enum(['MEASURED', 'ESTIMATED', 'NOT_VERIFIED']),
      estimatedCostUsd: z.number().min(0).optional(),
      providerCalls: z.array(z.object({
        provider: z.string(),
        model: z.string(),
        callCount: z.number().int().min(1).optional(),
        inputTokens: z.number().int().min(0),
        outputTokens: z.number().int().min(0),
        costType: z.enum(['ESTIMATED', 'NOT_VERIFIED']),
        estimatedCostUsd: z.number().min(0).optional(),
        pricingVersion: z.string().optional(),
        ratesUsdPerMillion: z.object({
          input: z.number().min(0),
          output: z.number().min(0),
          cacheRead: z.number().min(0),
          cacheWrite: z.number().min(0),
        }).optional(),
      })).default([]),
    }).optional(),
    jurisdictionCode: z.enum(['KE', 'RW', 'MW', 'NG']).nullable().optional(),
    verifierStatus: z.enum(['PASS', 'PARTIAL', 'FAIL']).optional(),
    unsupportedClaims: z.array(z.string()).optional(),
    retrievalVersion: z.string().optional(),
    depthEngineVersion: z.string().optional(),
    depthProfileVersion: z.string().optional(),
    executionProfileVersion: z.string().optional(),
    executionStages: z.object({
      retrieval: z.string(),
      documentTraversal: z.string(),
      enhancedReview: z.string(),
      verification: z.string(),
    }).optional(),
    executionMetrics: z.object({
      retrievalQueryCount: z.number().int().min(0),
      retrievalCandidateCount: z.number().int().min(0),
      acceptedEvidenceCount: z.number().int().min(0),
      weakEvidenceRetryCount: z.number().int().min(0),
      documentChunks: z.number().int().min(0),
      processedChunks: z.number().int().min(0),
      analysisCallCount: z.number().int().min(0),
      verificationCallCount: z.number().int().min(0),
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
      durationMs: z.number().int().min(0),
    }).optional(),
    lifecycleTelemetry: z.object({
      requestedAt: z.string().optional(),
      queuedAt: z.string().optional(),
      startedAt: z.string(),
      completedAt: z.string().optional(),
      failedAt: z.string().optional(),
      queueWaitMs: z.number().int().min(0).optional(),
      retrievalDurationMs: z.number().int().min(0).optional(),
      analysisDurationMs: z.number().int().min(0).optional(),
      verificationDurationMs: z.number().int().min(0).optional(),
      workerDurationMs: z.number().int().min(0).optional(),
      totalDurationMs: z.number().int().min(0).optional(),
    }).optional(),
    retrievalTelemetry: z.object({
      rawRetrieved: z.number().int().min(0),
      metadataCompatible: z.number().int().min(0).optional(),
      similarityQualified: z.number().int().min(0).optional(),
      reranked: z.number().int().min(0).optional(),
      gradedAccepted: z.number().int().min(0).optional(),
      finalEvidence: z.number().int().min(0),
      pineconeIndex: z.string().optional(),
      pineconeNamespace: z.string().optional(),
      corpusVersion: z.string().optional(),
      corpusReadiness: z.enum(['UNAVAILABLE', 'INDEXED_PARTIAL', 'VALIDATED_FOR_GAP_ANALYSIS', 'STALE_OR_UNKNOWN']).optional(),
    }).optional(),
    executionLimitations: z.array(z.string()).optional(),
  }),
});

/**
 * Raw gap item returned by the per-chunk phase.
 * Identical to GapItemSchema but includes a `framework` identifier so the
 * merge pass can group gaps by framework.
 */
export const RawChunkGapItemSchema = GapItemSchema.extend({
  framework: z.string(),
});

/** Zod schema for the full JSON array a single chunk analysis returns. */
export const ChunkOutputSchema = z.array(RawChunkGapItemSchema);

// Inferred types  -  use these throughout the codebase instead of manual interfaces.
export type RegulatoryEvidenceRef = z.infer<typeof RegulatoryEvidenceRefSchema>;
export type PolicyEvidenceRef = z.infer<typeof PolicyEvidenceRefSchema>;
export type FindingVerification = z.infer<typeof FindingVerificationSchema>;
export type FindingCoverage = z.infer<typeof FindingCoverageSchema>;
export type GapItem = z.infer<typeof GapItemSchema>;
export type FrameworkResult = z.infer<typeof FrameworkResultSchema>;
export type ActionPlanItem = z.infer<typeof ActionPlanItemSchema>;
export type GapAnalysisResult = z.infer<typeof GapAnalysisResultSchema>;
export type RawChunkGapItem = z.infer<typeof RawChunkGapItemSchema>;
export type ChunkOutput = z.infer<typeof ChunkOutputSchema>;

// --- Chunking Strategy (T1) -------------------------------------------------

export interface PolicyChunk {
  index: number;
  total: number;
  text: string;
  charStart: number;
  charEnd: number;
}

export const CHUNK_SIZE = 6000;
export const CHUNK_OVERLAP = 800;

export function chunkPolicyText(
  text: string,
  chunkSize = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP
): PolicyChunk[] {
  if (text.length <= chunkSize) {
    return [{ index: 0, total: 1, text, charStart: 0, charEnd: text.length }];
  }

  const paragraphs = text.split(/\n\n+/);
  const chunks: PolicyChunk[] = [];
  let current = '';
  let charStart = 0;
  let absolutePos = 0;

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;

    if (candidate.length <= chunkSize) {
      current = candidate;
    } else {
      if (current) {
        const charEnd = charStart + current.length;
        chunks.push({ index: chunks.length, total: 0, text: current, charStart, charEnd });
        const tail = current.length > overlap ? current.slice(-overlap) : current;
        charStart = charEnd - tail.length;
        current = `${tail}\n\n${para}`;
      } else {
        let pos = 0;
        while (pos < para.length) {
          let end = pos + chunkSize;
          if (end < para.length) {
            const ws = para.lastIndexOf(' ', end);
            if (ws > pos) end = ws;
          } else {
            end = para.length;
          }
          const slice = para.slice(pos, end);
          chunks.push({
            index: chunks.length,
            total: 0,
            text: slice,
            charStart: absolutePos + pos,
            charEnd: absolutePos + end,
          });
          pos = end - overlap;
          if (pos <= 0 || pos >= para.length) break;
        }
        current = '';
        charStart = absolutePos + para.length;
      }
    }
    absolutePos += para.length + 2;
  }

  if (current.trim()) {
    chunks.push({
      index: chunks.length,
      total: 0,
      text: current,
      charStart,
      charEnd: charStart + current.length,
    });
  }

  const total = chunks.length;
  for (const c of chunks) c.total = total;
  return chunks;
}

// --- Prompt Injection Sanitization -------------------------------------------

export function sanitizePolicyText(text: string): { sanitized: string; wasModified: boolean } {
  const patterns: RegExp[] = [
    /ignore\s+(all\s+)?previous\s+instructions?/gi,
    /ignore\s+(all\s+)?above\s+instructions?/gi,
    /disregard\s+(all\s+)?previous/gi,
    /instead[,\s]+output/gi,
    /new\s+instructions?\s*:/gi,
    /\bsystem\s*:\s*/gi,
    /\[SYSTEM\]/gi,
    /\[INST\]/gi,
    /<<SYS>>/gi,
    /<\|im_start\|>/gi,
    /forget\s+(everything|all)\s+(above|previous|prior)/gi,
    /you\s+are\s+now\s+a\s+different\s+(ai|assistant|model)/gi,
  ];

  let sanitized = text;
  let wasModified = false;

  for (const pattern of patterns) {
    if (pattern.test(sanitized)) {
      wasModified = true;
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    }
  }

  return { sanitized, wasModified };
}

// --- Shared Schema Example ----------------------------------------------------

function buildRequiredJsonSchema(params: {
  documentName: string;
  analysisDepth: string;
  regulatoryFrameworks: string[];
}): string {
  return `{
  "overallScore": 65,
  "assessmentCoverage": 100,
  "executiveSummary": "This policy demonstrates foundational compliance awareness but has significant gaps in data subject rights procedures (DPA 2019) and transaction monitoring thresholds (POCAMLA). Immediate action is required on 2 CRITICAL gaps before the policy can be considered regulatory-grade.",
  "frameworks": [
    {
      "id": "DPA_2019",
      "name": "Data Protection Act 2019",
      "score": 60,
      "summary": "The policy addresses basic data collection principles but lacks required procedures for data subject access requests, erasure, and breach notification.",
      "gaps": [
        {
          "id": "DPA-G001",
          "title": "No Data Subject Rights Procedure",
          "requirement": "Establish formal written procedures for handling data subject access requests, rectification, and erasure within 21 statutory days",
          "status": "GAP",
          "severity": "HIGH",
          "severityRationale": "Statutory non-compliance with statutory 21-day timeline creates direct ODPC enforcement and civil penalty risk",
          "regulatoryBasis": "Data Protection Act 2019, Section 26 - Right of access; Section 30 - Right to erasure",
          "description": "The policy does not define procedures for handling data subject requests (access, rectification, erasure, objection). The DPA requires responses within 21 days.",
          "policyCurrentState": "Policy mentions 'we respect privacy' but contains no operational procedure for handling subject rights requests.",
          "recommendation": "Draft and implement a Data Subject Rights Procedure covering: request intake form, 21-day response SLA, escalation process, and rejection grounds as per DPA Section 26-32.",
          "effort": "MEDIUM",
          "priority": 1,
          "evidenceIds": ["<EXACT_EVIDENCE_ID_FROM_RETRIEVED_CONTEXT>"],
          "policyEvidenceIds": ["<EXACT_POLICY_CHUNK_ID_FROM_POLICY_OR_EMPTY_IF_ABSENT>"],
          "evidenceRequired": ["Data Subject Rights Request Form", "Procedure SOP document", "Staff training records on DPA rights"],
          "responsibleRole": "Data Protection Officer",
          "regulatoryDeadline": "Immediate - DPA 2019 is in force; non-compliance risks ODPC enforcement"
        }
      ],
      "strengths": [
        "Policy correctly identifies lawful bases for data processing (DPA 2019, Section 30)",
        "Privacy notice obligations are acknowledged with reference to customer communication"
      ]
    }
  ],
  "crossCuttingStrengths": [
    "Policy demonstrates senior management commitment to compliance through board sign-off",
    "Annual review cycle is established"
  ],
  "actionPlan": [
    {
      "priority": 1,
      "action": "Draft and implement a Data Subject Rights Procedure",
      "framework": "Data Protection Act 2019",
      "deadline": "Within 30 days",
      "effort": "MEDIUM",
      "resources": ["DPO or external data protection counsel", "DPA 2019 Sections 26-32", "ODPC guidance on subject rights"],
      "responsibleRole": "Data Protection Officer (DPO)",
      "dependsOn": []
    }
  ],
  "metadata": {
    "documentName": "${params.documentName}",
    "analysisDepth": "${params.analysisDepth}",
    "frameworksAnalysed": ${JSON.stringify(params.regulatoryFrameworks)},
    "totalGaps": 0,
    "criticalGaps": 0,
    "highGaps": 0,
    "selectedBenchmarkDocuments": [],
    "scoringVersion": "${SCORING_VERSION_V2}",
    "analysisDate": "${new Date().toISOString()}"
  }
}`;
}

// --- Prompt Builders ---------------------------------------------------------

export function generateGapAnalysisSystemPrompt(jurisdictionContext?: JurisdictionContext): string {
  if (jurisdictionContext) {
    const jurisdictionName = jurisdictionContext.mode === 'SINGLE'
      ? jurisdictionLabel(jurisdictionContext.primaryJurisdiction)
      : jurisdictionContext.jurisdictions.map(jurisdictionLabel).join(', ');
    const jurisdictionCodes = jurisdictionContext.jurisdictions.join(', ');

    return `You are a senior financial regulatory compliance auditor specializing in source-grounded gap analysis for ${jurisdictionName}.

AUTHORIZED JURISDICTION:
- Jurisdiction: ${jurisdictionName}
- Country code(s): ${jurisdictionCodes}
- Regulatory corpus scope: ${jurisdictionCodes}

Your task is to compare the uploaded organization policy against retrieved regulatory evidence only.

MANDATORY RULES:
1. Use only retrieved regulatory context for legal obligations, penalties, deadlines, thresholds, licences, filings, and citations.
2. Every gap or compliant finding MUST cite the exact [EVIDENCE_ID: ...] from the retrieved regulatory context in the 'evidenceIds' array. Never fabricate or invent evidence IDs.
3. Every finding MUST cite the corresponding policy chunk in 'policyEvidenceIds' (e.g. ['pol-chunk-1']) if policy text mentions the topic, or empty [] if absent from the policy.
4. Rate 'status' truthfully: 'COMPLIANT' if fully satisfied, 'PARTIAL' if partially satisfied, or 'GAP' if missing or non-compliant.
5. Provide a deterministic 'severityRationale' explaining the operational and regulatory risk.
6. Do not import country-specific assumptions unless that country is the authorized jurisdiction and the retrieved evidence supports it.
7. If evidence is insufficient, abstain from legal conclusions and state that verified regulatory sources are required.
8. Return only valid JSON that matches the requested schema.`;
  }

  throw new Error('HOME_JURISDICTION_REQUIRED');
}

export function generateChunkAnalysisUserPrompt(
  params: Omit<GapAnalysisParams, 'policyText'> & { chunkText: string },
  chunkIndex: number,
  totalChunks: number
): string {
  const ragSection = params.ragContext
    ? `\n## RETRIEVED REGULATORY CONTEXT\n${params.ragContext}\n`
    : '';

  return `You are performing Phase 1 (chunk-level analysis) of a multi-chunk gap analysis.
This is chunk ${chunkIndex + 1} of ${totalChunks} for document "${params.documentName}".
Frameworks: ${params.regulatoryFrameworks.join(', ')}
${ragSection}
## POLICY CHUNK ${chunkIndex + 1}/${totalChunks} (ID: pol-chunk-${chunkIndex + 1})
\`\`\`
${params.chunkText}
\`\`\`

## INSTRUCTIONS
1. Identify specific gaps where this chunk fails to meet regulatory obligations.
2. For each finding, cite the exact [EVIDENCE_ID: ...] in 'evidenceIds' and set 'policyEvidenceIds' to ['pol-chunk-${chunkIndex + 1}'].
3. Rate severity: CRITICAL = immediate licence/regulatory risk; HIGH = likely finding/fine; MEDIUM = procedural deficiency; LOW = minor wording issue.
4. Output a JSON array of findings with schema:
{
  "framework": "<framework id>",
  "id": "<e.g. DPA-G001-C${chunkIndex + 1}>",
  "title": "...",
  "requirement": "...",
  "status": "GAP|COMPLIANT|PARTIAL",
  "severity": "CRITICAL|HIGH|MEDIUM|LOW",
  "severityRationale": "...",
  "regulatoryBasis": "...",
  "description": "...",
  "policyCurrentState": "...",
  "recommendation": "...",
  "effort": "LOW|MEDIUM|HIGH",
  "priority": 1,
  "evidenceIds": ["<EXACT_EVIDENCE_ID>"],
  "policyEvidenceIds": ["pol-chunk-${chunkIndex + 1}"],
  "evidenceRequired": ["..."],
  "responsibleRole": "...",
  "regulatoryDeadline": "..."
}

Return [] if no gaps are found. Return ONLY a valid JSON array.`;
}

export function generateMergeUserPrompt(
  rawGaps: unknown[],
  params: Omit<GapAnalysisParams, 'policyText'> & { chunkCount: number }
): string {
  const ragSection = params.ragContext
    ? `\n## RETRIEVED REGULATORY CONTEXT\n${params.ragContext}\n`
    : '';

  const depthInstructions: Record<string, string> = {
    quick: 'Focus on CRITICAL and HIGH severity gaps. Merge minor duplicates aggressively.',
    standard: 'Cover all severity levels. Merge obvious duplicates.',
    deep: 'Retain all distinct gaps. Only merge exact duplicates.',
  };

  return `You have received pre-identified compliance gaps from a ${params.chunkCount}-chunk analysis of "${params.documentName}".
Your task: consolidate, de-duplicate, score, and produce the final GapAnalysisResult JSON.

Analysis depth: ${params.analysisDepth} - ${depthInstructions[params.analysisDepth] ?? depthInstructions.standard}
Frameworks: ${params.regulatoryFrameworks.join(', ')}
${ragSection}
## RAW GAPS FROM ALL CHUNKS (${(rawGaps as unknown[]).length} total - some may be duplicates)
\`\`\`json
${JSON.stringify(rawGaps, null, 2)}
\`\`\`

## CONSOLIDATION INSTRUCTIONS
1. De-duplicate gaps describing the same issue - keep the most detailed entry, reassign sequential priority numbers. Combine their evidenceIds and policyEvidenceIds.
2. Group final gaps by framework into the frameworks array.
3. Write a concise executiveSummary (2-4 sentences).
4. Build a prioritised actionPlan.
5. Set metadata.chunksProcessed = ${params.chunkCount}.
6. Set metadata.scoringVersion = "${SCORING_VERSION_V2}".

## REQUIRED JSON SCHEMA
\`\`\`json
${buildRequiredJsonSchema({ documentName: params.documentName, analysisDepth: params.analysisDepth, regulatoryFrameworks: params.regulatoryFrameworks })}
\`\`\`

Return ONLY valid JSON.`;
}

export function generateGapAnalysisUserPrompt(params: GapAnalysisParams): string {
  if (!params.jurisdictionContext) throw new Error('HOME_JURISDICTION_REQUIRED');
  const jurisdictionName = params.jurisdictionContext
    ? (params.jurisdictionContext.mode === 'SINGLE'
      ? jurisdictionLabel(params.jurisdictionContext.primaryJurisdiction)
      : params.jurisdictionContext.jurisdictions.map(jurisdictionLabel).join(', '))
    : 'Kenya';
  const jurisdictionCodes = params.jurisdictionContext
    ? params.jurisdictionContext.jurisdictions.join(', ')
    : 'KE';
  const depthInstructions: Record<string, string> = {
    quick: 'Focus on CRITICAL and HIGH severity gaps only. Generate 2-3 gaps per framework maximum. Provide a high-level executive summary.',
    standard: 'Cover all severity levels. Generate 3-7 gaps per framework. Provide detailed analysis of each gap.',
    deep: 'Comprehensive analysis. Cover all severity levels thoroughly. Generate as many gaps as genuinely found (no limit).',
  };

  const ragSection = params.ragContext
    ? `\n\n## RETRIEVED REGULATORY CONTEXT\nThe following passages were retrieved from the SheriaBot regulatory corpus for ${jurisdictionName} (${jurisdictionCodes}). Every regulatory claim must cite the corresponding [EVIDENCE_ID: ...]:\n\n${params.ragContext}\n`
    : `\n\n## SOURCE INSUFFICIENCY\nNo retrieved regulatory source context was provided. Do not identify legal gaps, legal obligations, penalties, deadlines, or compliance conclusions. State that verified source documents are required and do not rely on model memory.\n`;

  const focusSection =
    params.focusAreas && params.focusAreas.length > 0
      ? `\n## PRIORITY FOCUS AREAS\nPay particular attention to these areas: ${params.focusAreas.join(', ')}\n`
      : '';

  return `Conduct a ${params.analysisDepth.toUpperCase()} gap analysis of the following policy document against the specified ${jurisdictionName} regulatory frameworks.

## ANALYSIS SCOPE
- **Authorized Jurisdiction:** ${jurisdictionName} (${jurisdictionCodes})
- **Document:** ${params.documentName} (${params.documentType.toUpperCase()})
- **Regulatory Frameworks:** ${params.regulatoryFrameworks.join(', ')}
- **Analysis Depth:** ${params.analysisDepth} - ${depthInstructions[params.analysisDepth] ?? depthInstructions.standard}
${focusSection}${ragSection}

## POLICY DOCUMENT TO ANALYSE
\`\`\`
${params.policyText}
\`\`\`

## EVIDENCE GROUNDING MANDATE
1. Every gap or compliant finding MUST cite the exact [EVIDENCE_ID: ...] in 'evidenceIds' from the retrieved regulatory context. Never invent IDs.
2. If the policy mentions the requirement, cite the relevant policy chunk in 'policyEvidenceIds' (e.g. ['pol-chunk-1']). If absent, use [].
3. Provide an explicit 'requirement' and 'severityRationale'.

## REQUIRED JSON SCHEMA
\`\`\`json
${buildRequiredJsonSchema(params)}
\`\`\`

Return ONLY valid JSON.`;
}

// --- Deterministic Gap Scoring Service (Legacy Compatibility) ----------------

export const GAP_SCORING_VERSION = 'v1.0-deterministic';

export interface DeterministicScoreBreakdown {
  calculatedScore: number;
  modelSuggestedScore?: number;
  scoringVersion: string;
  penalties: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    totalPenalty: number;
  };
  gapCounts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
}

export function calculateDeterministicGapScore(
  gaps: Array<{ severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' }>,
  modelSuggestedScore?: number
): DeterministicScoreBreakdown {
  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;

  for (const gap of gaps) {
    if (gap.severity === 'CRITICAL') critical++;
    else if (gap.severity === 'HIGH') high++;
    else if (gap.severity === 'MEDIUM') medium++;
    else if (gap.severity === 'LOW') low++;
  }

  const criticalPenalty = critical * 25;
  const highPenalty = high * 15;
  const mediumPenalty = medium * 8;
  const lowPenalty = low * 3;
  const totalPenalty = criticalPenalty + highPenalty + mediumPenalty + lowPenalty;
  const calculatedScore = Math.max(0, Math.min(100, 100 - totalPenalty));

  return {
    calculatedScore,
    modelSuggestedScore,
    scoringVersion: GAP_SCORING_VERSION,
    penalties: {
      critical: criticalPenalty,
      high: highPenalty,
      medium: mediumPenalty,
      low: lowPenalty,
      totalPenalty,
    },
    gapCounts: {
      critical,
      high,
      medium,
      low,
      total: gaps.length,
    },
  };
}

// --- Output Parser ------------------------------------------------------------

export function parseGapAnalysisOutput(rawContent: string): GapAnalysisResult {
  let content = rawContent.trim();

  if (content.startsWith('```')) {
    content = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('AI response does not contain valid JSON');
    }
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      let braces = 0;
      let brackets = 0;
      for (const char of jsonMatch[0]) {
        if      (char === '{') braces++;
        else if (char === '}') braces--;
        else if (char === '[') brackets++;
        else if (char === ']') brackets--;
      }

      let repaired = jsonMatch[0].trim().replace(/,\s*$/, '');
      while (brackets > 0) { repaired += ']'; brackets--; }
      while (braces   > 0) { repaired += '}'; braces--;   }

      try {
        parsed = JSON.parse(repaired);
      } catch (repairErr: unknown) {
        throw new Error(`AI response contains malformed JSON that could not be repaired: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}`);
      }
    }
  }

  const result = GapAnalysisResultSchema.safeParse(parsed);
  if (!result.success) {
    const firstError = result.error.issues[0];
    throw new Error(
      `Invalid gap analysis structure: ${firstError.path.join('.')} - ${firstError.message}`
    );
  }

  const validated = result.data;

  // Recompute metadata counts from actual validated gaps
  let totalGaps = 0;
  let criticalGaps = 0;
  let highGaps = 0;
  let mediumGaps = 0;
  let lowGaps = 0;

  const assessments: RequirementAssessment[] = [];

  for (const framework of validated.frameworks) {
    totalGaps += framework.gaps.length;
    for (const gap of framework.gaps) {
      if (gap.severity === 'CRITICAL') criticalGaps++;
      else if (gap.severity === 'HIGH') highGaps++;
      else if (gap.severity === 'MEDIUM') mediumGaps++;
      else if (gap.severity === 'LOW') lowGaps++;

      assessments.push({
        id: gap.id,
        frameworkSlug: gap.frameworkSlug ?? framework.id,
        jurisdiction: gap.jurisdiction ?? 'KE',
        requirement: gap.requirement || gap.title,
        status: gap.status,
        severity: gap.severity,
        severityRationale: gap.severityRationale || gap.description,
        policyEvidence: gap.policyEvidence ?? [],
        regulatoryEvidence: gap.regulatoryEvidence ?? [],
        verification: gap.verification ?? { verdict: 'NOT_VERIFIABLE' },
        coverage: gap.coverage ?? { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
      });
    }
  }

  validated.metadata.totalGaps = totalGaps;
  validated.metadata.criticalGaps = criticalGaps;
  validated.metadata.highGaps = highGaps;
  validated.metadata.mediumGaps = mediumGaps;
  validated.metadata.lowGaps = lowGaps;
  validated.metadata.analysisDate = new Date().toISOString();
  validated.metadata.modelSuggestedScore = validated.overallScore;

  const hasV2EvidenceOrVerification = validated.frameworks.some((f) =>
    f.gaps.some(
      (g) =>
        (g.regulatoryEvidence && g.regulatoryEvidence.length > 0) ||
        (g.policyEvidence && g.policyEvidence.length > 0) ||
        (g.evidenceIds && g.evidenceIds.length > 0) ||
        (g.policyEvidenceIds && g.policyEvidenceIds.length > 0) ||
        (g.verification && g.verification.verdict !== 'NOT_VERIFIABLE')
    )
  );

  // Determine scoring engine: use v2 if explicitly requested as v2 or if findings have v2 evidence/verification, unless explicitly v1
  if (
    validated.metadata.scoringVersion !== 'v1.0-deterministic' &&
    (validated.metadata.scoringVersion === SCORING_VERSION_V2 || hasV2EvidenceOrVerification)
  ) {
    const docCoverage: DocumentCoverage = validated.metadata.documentCoverage ?? {
      totalChunks: validated.metadata.chunksProcessed ?? 1,
      processedChunks: validated.metadata.chunksProcessed ?? 1,
      failedChunks: 0,
      skippedChunks: 0,
      extractionComplete: true,
    };

    const scoringResult = calculateComplianceAlignmentScore({
      assessments,
      documentCoverage: docCoverage,
    });

    validated.metadata.scoringVersion = SCORING_VERSION_V2;
    validated.metadata.calculatedScore = scoringResult.complianceAlignmentScore;
    validated.metadata.complianceAlignmentScore = scoringResult.complianceAlignmentScore;
    validated.metadata.assessmentCoverageScore = scoringResult.assessmentCoverageScore;
    validated.metadata.coverageStatus = scoringResult.coverageStatus;
    (validated as any).scoringVersion = SCORING_VERSION_V2;
    (validated as any).complianceAlignmentScore = scoringResult.complianceAlignmentScore;
    (validated as any).assessmentCoverageScore = scoringResult.assessmentCoverageScore;
    (validated as any).coverageStatus = scoringResult.coverageStatus;
    validated.overallScore = scoringResult.complianceAlignmentScore;
    validated.assessmentCoverage = scoringResult.assessmentCoverageScore;
  } else {
    // Legacy scoring
    const legacyGaps = assessments.map((a) => ({ severity: a.severity as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' }));
    const legacyResult = calculateDeterministicGapScore(legacyGaps, validated.overallScore);
    validated.metadata.scoringVersion = legacyResult.scoringVersion;
    validated.metadata.calculatedScore = legacyResult.calculatedScore;
    validated.overallScore = legacyResult.calculatedScore;
    validated.assessmentCoverage = 100;
  }

  return validated as GapAnalysisResult;
}

export function parseChunkAnalysisOutput(rawContent: string, chunkIndex: number): RawChunkGapItem[] {
  let content = rawContent.trim();

  if (content.startsWith('```')) {
    content = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
  }

  if (!content || content === '[]') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const arrayMatch = content.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      throw new Error(`Chunk ${chunkIndex}: AI response contains no valid JSON array`);
    }
    try {
      parsed = JSON.parse(arrayMatch[0]);
    } catch {
      let braces = 0;
      let brackets = 0;
      for (const char of arrayMatch[0]) {
        if      (char === '{') braces++;
        else if (char === '}') braces--;
        else if (char === '[') brackets++;
        else if (char === ']') brackets--;
      }

      let repaired = arrayMatch[0].trim().replace(/,\s*$/, '');
      while (brackets > 0) { repaired += ']'; brackets--; }
      while (braces   > 0) { repaired += '}'; braces--;   }

      try {
        parsed = JSON.parse(repaired);
      } catch (repairErr: unknown) {
        throw new Error(`Chunk ${chunkIndex} AI response contains malformed JSON that could not be repaired: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}`);
      }
    }
  }

  const result = ChunkOutputSchema.safeParse(parsed);
  if (!result.success) {
    const firstError = result.error.issues[0];
    throw new Error(
      `Chunk ${chunkIndex} validation failed: ${firstError.path.join('.')} - ${firstError.message}`
    );
  }

  return result.data;
}
