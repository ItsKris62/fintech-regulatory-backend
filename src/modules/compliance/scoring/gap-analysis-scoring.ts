import { type JurisdictionCode } from '@/types/jurisdiction';

// ─── STABLE EVIDENCE IDENTIFIERS ─────────────────────────────────────────────

export interface RegulatoryEvidenceRef {
  evidenceId: string; // Stable Pinecone vectorId or chunkId
  vectorId: string;
  documentId?: string | null;
  documentTitle: string;
  jurisdiction: JurisdictionCode | 'GLOBAL' | 'INTERNATIONAL';
  frameworkSlug: string;
  sourceAuthority?: string;
  section?: string;
  page?: number;
  effectiveDate?: string;
  sourceStatus?: string;
  excerpt: string;
  similarityScore?: number;
  rerankScore?: number;
}

export interface PolicyEvidenceRef {
  policyEvidenceId: string; // e.g. "pol-chunk-1", "pol-sec-2"
  chunkIndex?: number;
  page?: number;
  sectionHeading?: string;
  excerpt: string;
  startOffset?: number;
  endOffset?: number;
}

// ─── COVERAGE & COMPLETENESS CONTRACTS ───────────────────────────────────────

export interface DocumentCoverage {
  totalChunks: number;
  processedChunks: number;
  failedChunks: number;
  skippedChunks: number;
  extractionComplete: boolean;
}

export type FrameworkEvidenceStatus = 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT' | 'UNAVAILABLE';

export interface FrameworkCoverage {
  frameworkSlug: string;
  evidenceStatus: FrameworkEvidenceStatus;
  assessedRequirementCount: number;
  totalKnownRequirementCount?: number;
  unassessedRequirementCount?: number;
  notes?: string[];
}

// ─── FINDING-LEVEL VERIFICATION CONTRACT ─────────────────────────────────────

export type VerificationVerdict =
  | 'SUPPORTED'
  | 'PARTIALLY_SUPPORTED'
  | 'UNSUPPORTED'
  | 'NOT_VERIFIABLE';

export interface FindingVerification {
  verdict: VerificationVerdict;
  confidence?: number;
  unsupportedClaims?: string[];
  reason?: string;
}

export interface FindingCoverage {
  regulatoryEvidenceAvailable: boolean;
  policySectionAssessed: boolean;
  extractionComplete: boolean;
}

// ─── REQUIREMENT ASSESSMENT & FINDING CONTRACT ───────────────────────────────

export type RequirementOutcome =
  | 'COMPLIANT'
  | 'PARTIAL'
  | 'GAP'
  | 'NOT_ASSESSED'
  | 'INSUFFICIENT_EVIDENCE';

export type FindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface RequirementAssessment {
  id: string;
  frameworkSlug: string;
  jurisdiction: JurisdictionCode;
  requirement: string;
  requirementSummary?: string;
  status: RequirementOutcome;
  severity: FindingSeverity;
  severityRationale: string;
  weight?: number; // Deterministic weight (e.g. CRITICAL=5, HIGH=4, etc.)
  policyEvidence: PolicyEvidenceRef[];
  regulatoryEvidence: RegulatoryEvidenceRef[];
  gapDescription?: string;
  remediation?: string;
  verification: FindingVerification;
  coverage: FindingCoverage;
  requestedEvidenceIds?: string[];
  resolvedEvidenceIds?: string[];
  invalidEvidenceIds?: string[];
  requestedPolicyEvidenceIds?: string[];
  resolvedPolicyEvidenceIds?: string[];
  invalidPolicyEvidenceIds?: string[];
}

// ─── DETERMINISTIC SCORING ENGINE ───────────────────────────────────────────

export const SCORING_VERSION_V2 = 'v2.0-evidence-backed';
export const SCORING_VERSION_V3 = 'v3.0-reviewed-inventory';
export type InventoryCompleteness = 'UNKNOWN' | 'PARTIAL' | 'COMPLETE';

export const OUTCOME_SCORES: Record<RequirementOutcome, number> = {
  COMPLIANT: 1.0,
  PARTIAL: 0.5,
  GAP: 0.0,
  NOT_ASSESSED: 0.0, // Excluded from alignment denominator
  INSUFFICIENT_EVIDENCE: 0.0, // Excluded from alignment denominator
};

export const SEVERITY_WEIGHTS: Record<FindingSeverity, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  INFO: 0,
};

export interface CalculatedScoringResult {
  scoringVersion: string;
  complianceAlignmentScore: number; // 0 - 100
  assessmentCoverageScore: number;   // 0 - 100
  overallScore: number;             // Alias for alignment score
  coverageStatus: 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT' | 'UNKNOWN';
  assessmentCoverage: 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT' | 'UNKNOWN'; // Alias for coverageStatus
  inventoryCompleteness: InventoryCompleteness;
  assessedCount: number;
  validAssessedCount: number;
  totalCount: number;
  breakdown: {
    compliantCount: number;
    partialCount: number;
    gapCount: number;
    notAssessedCount: number;
    insufficientEvidenceCount: number;
    unsupportedQuarantinedCount: number;
    partiallySupportedCount?: number;
    notVerifiableCount?: number;
  };
  documentCoverage: DocumentCoverage;
}

/**
 * Pure, deterministic calculation of Compliance Alignment Score and Assessment Coverage.
 *
 * Principles:
 * 1. Alignment score reflects the weighted achievement across validly assessed requirements.
 * 2. Requirements with verification verdict 'UNSUPPORTED' are quarantined and do not contribute
 *    positively or negatively to the score.
 * 3. Requirements with verification verdict 'NOT_VERIFIABLE' cannot improve alignment and reduce coverage.
 * 4. Requirements with verdict 'PARTIALLY_SUPPORTED' contribute discounted credit (0.5x) rather than full credit.
 * 5. NOT_ASSESSED and INSUFFICIENT_EVIDENCE do not count toward alignment points, but reduce coverage.
 * 6. Assessment Coverage accounts for document completeness (processed / total chunks) and
 *    the proportion of requirements with sufficient regulatory and policy evidence.
 * 7. A percentage coverage is unavailable without an explicit reviewed scope;
 *    model-selected findings can never become its denominator.
 */
export function calculateComplianceAlignmentScore(params: {
  assessments: RequirementAssessment[];
  documentCoverage: DocumentCoverage;
  expectedRequirementCount?: number;
  hasKnownRequirementInventory?: boolean;
  inventoryCompleteness?: InventoryCompleteness;
}): CalculatedScoringResult {
  const { assessments, documentCoverage, expectedRequirementCount, hasKnownRequirementInventory } = params;
  // Omitted is legacy compatibility only. New Gap Analysis callers must pass
  // inventoryCompleteness explicitly; they use UNKNOWN until reviewed scope is loaded.
  const inventoryCompleteness: InventoryCompleteness = params.inventoryCompleteness
    ?? (hasKnownRequirementInventory === false ? 'UNKNOWN' : 'COMPLETE');

  let totalWeightedScore = 0;
  let totalWeight = 0;

  let compliantCount = 0;
  let partialCount = 0;
  let gapCount = 0;
  let notAssessedCount = 0;
  let insufficientEvidenceCount = 0;
  let unsupportedQuarantinedCount = 0;
  let notVerifiableCount = 0;
  let partiallySupportedCount = 0;
  let validAssessedCount = 0;

  for (const item of assessments) {
    // 1. Quarantined: Unsupported verification verdict cannot contribute to score
    if (item.verification.verdict === 'UNSUPPORTED') {
      unsupportedQuarantinedCount++;
      continue;
    }

    // 2. Not Verifiable: Missing regulatory or policy evidence basis cannot improve alignment
    if (item.verification.verdict === 'NOT_VERIFIABLE') {
      notVerifiableCount++;
      insufficientEvidenceCount++;
      continue;
    }

    const weight = item.weight ?? SEVERITY_WEIGHTS[item.severity] ?? 3;
    const isPartialGrounding = item.verification.verdict === 'PARTIALLY_SUPPORTED';
    if (isPartialGrounding) {
      partiallySupportedCount++;
    }

    if (item.status === 'COMPLIANT') {
      compliantCount++;
      validAssessedCount++;
      // Partially supported compliance receives discounted 0.5 factor instead of full 1.0
      const outcomeScore = isPartialGrounding ? 0.5 : OUTCOME_SCORES.COMPLIANT;
      totalWeightedScore += weight * outcomeScore;
      totalWeight += weight;
    } else if (item.status === 'PARTIAL') {
      partialCount++;
      validAssessedCount++;
      const outcomeScore = isPartialGrounding ? 0.25 : OUTCOME_SCORES.PARTIAL;
      totalWeightedScore += weight * outcomeScore;
      totalWeight += weight;
    } else if (item.status === 'GAP') {
      gapCount++;
      validAssessedCount++;
      totalWeightedScore += weight * OUTCOME_SCORES.GAP;
      totalWeight += weight;
    } else if (item.status === 'NOT_ASSESSED') {
      notAssessedCount++;
    } else if (item.status === 'INSUFFICIENT_EVIDENCE') {
      insufficientEvidenceCount++;
    }
  }

  // 1. Compliance Alignment Score (0-100)
  const alignmentScore =
    totalWeight > 0 ? Math.round((totalWeightedScore / totalWeight) * 100) : 0;

  // 2. Assessment Coverage (0-100)
  const hasDeclaredDenominator = inventoryCompleteness !== 'UNKNOWN';
  const denominatorRequirements = hasDeclaredDenominator
    ? Math.max(expectedRequirementCount ?? assessments.length, 1)
    : 0;

  const requirementCoverageFactor =
    denominatorRequirements > 0
      ? validAssessedCount / denominatorRequirements
      : 0;

  const docProcessingFactor =
    documentCoverage.totalChunks > 0
      ? Math.max(0, documentCoverage.processedChunks - documentCoverage.failedChunks) /
        documentCoverage.totalChunks
      : 1.0;

  const rawCoverage = Math.round(
    requirementCoverageFactor * docProcessingFactor * 100,
  );

  // Preserve the numeric field for additive backward compatibility, but the
  // UNKNOWN status makes it unavailable to presentation layers.
  const assessmentCoverageScore = hasDeclaredDenominator ? Math.max(0, Math.min(100, rawCoverage)) : 0;

  // Determine coverage qualitative status
  let coverageStatus: 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT' | 'UNKNOWN' = inventoryCompleteness === 'UNKNOWN' ? 'UNKNOWN' : 'COMPLETE';
  if (coverageStatus !== 'UNKNOWN' && (
    documentCoverage.failedChunks > 0 ||
    insufficientEvidenceCount > 0 ||
    unsupportedQuarantinedCount > 0 ||
    notVerifiableCount > 0 ||
    !documentCoverage.extractionComplete ||
    assessmentCoverageScore < 60
  )) {
    coverageStatus = 'INSUFFICIENT';
  } else if (coverageStatus !== 'UNKNOWN' && (
    assessmentCoverageScore < 95 ||
    notAssessedCount > 0 ||
    documentCoverage.skippedChunks > 0 ||
    inventoryCompleteness !== 'COMPLETE'
  )) {
    coverageStatus = 'PARTIAL';
  }

  return {
    scoringVersion: params.inventoryCompleteness !== undefined || hasKnownRequirementInventory === false
      ? SCORING_VERSION_V3
      : SCORING_VERSION_V2,
    complianceAlignmentScore: alignmentScore,
    assessmentCoverageScore,
    overallScore: alignmentScore,
    coverageStatus,
    assessmentCoverage: coverageStatus,
    inventoryCompleteness,
    assessedCount: assessments.length,
    validAssessedCount,
    totalCount: denominatorRequirements,
    breakdown: {
      compliantCount,
      partialCount,
      gapCount,
      notAssessedCount,
      insufficientEvidenceCount,
      unsupportedQuarantinedCount,
      partiallySupportedCount,
      notVerifiableCount,
    },
    documentCoverage,
  };
}
