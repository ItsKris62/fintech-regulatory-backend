import { BlogJurisdiction, BlogSourceQuality, BlogSuggestionPriority, BlogVerificationStatus } from '@prisma/client';

/**
 * Shared, server-computed requiresHumanReview policy (Pack 1 Foundation E,
 * corrected per phase-b-foundations.md). This is the ONLY place this policy
 * is evaluated - callers persist the result, they must never recompute it
 * with ad hoc logic of their own.
 *
 * Design note: this function evaluates whatever evidence is ACTUALLY
 * available at the caller's current pipeline stage. Suggestion creation only
 * has source/scoring evidence (`research`/`verification` are omitted -
 * undefined, not faked). Research completion adds `research`. Verification
 * adds `verification`. Never force absent later-stage evidence into a fake
 * default that would always flip `required` to true - undefined fields are
 * simply not evaluated.
 */

export type HumanReviewReason =
  | 'MISSING_REQUIRED_OFFICIAL_SOURCE'
  | 'INSUFFICIENT_SOURCE_QUALITY'
  | 'UNSUPPORTED_JURISDICTION'
  | 'UNRESOLVED_EVIDENCE_GAPS'
  | 'CONTRADICTORY_SOURCES'
  | 'SEMANTIC_CLAIM_NOT_VERIFIED'
  | 'VERIFICATION_NEEDS_REVIEW_OR_BLOCKED'
  | 'LOW_STRUCTURED_AI_CONFIDENCE';

export interface HumanReviewEvaluation {
  required: boolean;
  reasons: HumanReviewReason[];
}

export interface ResearchEvidenceInput {
  evidenceGapCount: number;
  contradictionCount: number;
}

export interface VerificationEvidenceInput {
  status: BlogVerificationStatus;
  /** True if any linked BlogVerificationIssue has claimCategory set and claimVerificationStatus !== 'VERIFIED'. */
  hasUnverifiedSemanticClaim: boolean;
}

export interface ComputeRequiresHumanReviewInput {
  /**
   * Whether the post's category requires an OFFICIAL source (mirrors the
   * category rule already enforced in blog-verification.service.ts -
   * duplicated here deliberately rather than importing it, since that module
   * is verification-stage code out of scope for this stage; see
   * OFFICIAL_SOURCE_REQUIRED_CATEGORIES below and the note in
   * phase-c3-c5-test-report.md about reconciling this in Stage C8).
   */
  categoryRequiresOfficialSource: boolean;
  hasOfficialSource: boolean;
  sourceQuality: BlogSourceQuality;
  priority: BlogSuggestionPriority;
  /** Plain string - RegulatorySignal-derived candidates carry jurisdiction as a free string, not the typed enum. */
  jurisdiction: string;
  supportedJurisdictions?: readonly string[];
  structuredAiConfidence?: number;
  confidenceThreshold?: number;
  research?: ResearchEvidenceInput;
  verification?: VerificationEvidenceInput;
}

export const OFFICIAL_SOURCE_REQUIRED_CATEGORIES: readonly string[] = [
  'Regulatory Updates',
  'Enforcement & Penalties',
];

export const DEFAULT_SUPPORTED_JURISDICTIONS: readonly string[] = Object.values(BlogJurisdiction);

/** 0-100 scale, matching phase-b-foundations.md Foundation E's "initial default: 0.7". */
export const DEFAULT_STRUCTURED_AI_CONFIDENCE_THRESHOLD = 70;

const HIGH_PRIORITY_LEVELS: readonly BlogSuggestionPriority[] = [BlogSuggestionPriority.HIGH, BlogSuggestionPriority.URGENT];
const HIGH_QUALITY_LEVELS: readonly BlogSourceQuality[] = [BlogSourceQuality.HIGH, BlogSourceQuality.OFFICIAL];
const REVIEW_TRIGGERING_VERIFICATION_STATUSES: readonly BlogVerificationStatus[] = [
  BlogVerificationStatus.NEEDS_REVIEW,
  BlogVerificationStatus.BLOCKED,
];

export function computeRequiresHumanReview(input: ComputeRequiresHumanReviewInput): HumanReviewEvaluation {
  const reasons: HumanReviewReason[] = [];

  if (input.categoryRequiresOfficialSource && !input.hasOfficialSource) {
    reasons.push('MISSING_REQUIRED_OFFICIAL_SOURCE');
  }

  if (HIGH_PRIORITY_LEVELS.includes(input.priority) && !HIGH_QUALITY_LEVELS.includes(input.sourceQuality)) {
    reasons.push('INSUFFICIENT_SOURCE_QUALITY');
  }

  const supportedJurisdictions = input.supportedJurisdictions ?? DEFAULT_SUPPORTED_JURISDICTIONS;
  if (!supportedJurisdictions.includes(input.jurisdiction)) {
    reasons.push('UNSUPPORTED_JURISDICTION');
  }

  if (input.research) {
    if (input.research.evidenceGapCount > 0) {
      reasons.push('UNRESOLVED_EVIDENCE_GAPS');
    }
    if (input.research.contradictionCount > 0) {
      reasons.push('CONTRADICTORY_SOURCES');
    }
  }

  if (input.verification) {
    if (REVIEW_TRIGGERING_VERIFICATION_STATUSES.includes(input.verification.status)) {
      reasons.push('VERIFICATION_NEEDS_REVIEW_OR_BLOCKED');
    }
    if (input.verification.hasUnverifiedSemanticClaim) {
      reasons.push('SEMANTIC_CLAIM_NOT_VERIFIED');
    }
  }

  if (input.structuredAiConfidence !== undefined) {
    const threshold = input.confidenceThreshold ?? DEFAULT_STRUCTURED_AI_CONFIDENCE_THRESHOLD;
    if (input.structuredAiConfidence < threshold) {
      reasons.push('LOW_STRUCTURED_AI_CONFIDENCE');
    }
  }

  return { required: reasons.length > 0, reasons };
}

/**
 * Suggestion-creation-time-only shape: exactly the fields
 * createSuggestionFromSourceItem already persists on BlogArticleSuggestion.
 * Used both to compute the value at creation and to re-derive reasons later
 * from a stored row (see "no new column" decision in
 * phase-c3-c5-test-report.md - reasons are recomputed on demand from already-
 * persisted evidence rather than stored as a separate field).
 */
export interface SuggestionCreationEvidence {
  category: string;
  requiresOfficialSource: boolean;
  sourceQuality: BlogSourceQuality;
  priority: BlogSuggestionPriority;
  jurisdiction: string;
}

export function computeRequiresHumanReviewAtCreation(evidence: SuggestionCreationEvidence): HumanReviewEvaluation {
  return computeRequiresHumanReview({
    categoryRequiresOfficialSource: OFFICIAL_SOURCE_REQUIRED_CATEGORIES.includes(evidence.category),
    // BlogArticleSuggestion.requiresOfficialSource is set by relevance-scoring.service.ts
    // as `item.sourceType !== 'OFFICIAL'` - i.e. it is true when the linked
    // source is NOT itself official. hasOfficialSource is its inverse.
    hasOfficialSource: !evidence.requiresOfficialSource,
    sourceQuality: evidence.sourceQuality,
    priority: evidence.priority,
    jurisdiction: evidence.jurisdiction,
  });
}
