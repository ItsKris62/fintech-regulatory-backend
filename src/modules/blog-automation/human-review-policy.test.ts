import { describe, it, expect } from 'vitest';
import { BlogSourceQuality, BlogSuggestionPriority, BlogVerificationStatus } from '@prisma/client';
import {
  computeRequiresHumanReview,
  computeRequiresHumanReviewAtCreation,
  DEFAULT_STRUCTURED_AI_CONFIDENCE_THRESHOLD,
  type ComputeRequiresHumanReviewInput,
} from './human-review-policy';

function safeInput(overrides: Partial<ComputeRequiresHumanReviewInput> = {}): ComputeRequiresHumanReviewInput {
  return {
    categoryRequiresOfficialSource: false,
    hasOfficialSource: true,
    sourceQuality: BlogSourceQuality.OFFICIAL,
    priority: BlogSuggestionPriority.LOW,
    jurisdiction: 'KE',
    ...overrides,
  };
}

describe('computeRequiresHumanReview', () => {
  it('returns required: false with no reasons for a fully safe candidate', () => {
    const result = computeRequiresHumanReview(safeInput());
    expect(result).toEqual({ required: false, reasons: [] });
  });

  it('flags MISSING_REQUIRED_OFFICIAL_SOURCE when the category requires one and none exists', () => {
    const result = computeRequiresHumanReview(
      safeInput({ categoryRequiresOfficialSource: true, hasOfficialSource: false }),
    );
    expect(result.required).toBe(true);
    expect(result.reasons).toContain('MISSING_REQUIRED_OFFICIAL_SOURCE');
  });

  it('does not flag a missing official source when the category does not require one', () => {
    const result = computeRequiresHumanReview(
      safeInput({ categoryRequiresOfficialSource: false, hasOfficialSource: false }),
    );
    expect(result.reasons).not.toContain('MISSING_REQUIRED_OFFICIAL_SOURCE');
  });

  it('flags INSUFFICIENT_SOURCE_QUALITY for a HIGH/URGENT suggestion with low source quality', () => {
    const result = computeRequiresHumanReview(
      safeInput({ priority: BlogSuggestionPriority.URGENT, sourceQuality: BlogSourceQuality.MEDIUM }),
    );
    expect(result.required).toBe(true);
    expect(result.reasons).toContain('INSUFFICIENT_SOURCE_QUALITY');
  });

  it('does not flag source quality for a LOW/MEDIUM priority suggestion regardless of quality', () => {
    const result = computeRequiresHumanReview(
      safeInput({ priority: BlogSuggestionPriority.MEDIUM, sourceQuality: BlogSourceQuality.LOW }),
    );
    expect(result.reasons).not.toContain('INSUFFICIENT_SOURCE_QUALITY');
  });

  it('flags UNSUPPORTED_JURISDICTION for a jurisdiction outside the supported set', () => {
    const result = computeRequiresHumanReview(safeInput({ jurisdiction: 'ZZ' }));
    expect(result.required).toBe(true);
    expect(result.reasons).toContain('UNSUPPORTED_JURISDICTION');
  });

  it('flags UNRESOLVED_EVIDENCE_GAPS only when research evidence is provided and non-empty', () => {
    const withGaps = computeRequiresHumanReview(safeInput({ research: { evidenceGapCount: 2, contradictionCount: 0 } }));
    expect(withGaps.reasons).toContain('UNRESOLVED_EVIDENCE_GAPS');

    const withoutResearch = computeRequiresHumanReview(safeInput());
    expect(withoutResearch.reasons).not.toContain('UNRESOLVED_EVIDENCE_GAPS');
  });

  it('flags CONTRADICTORY_SOURCES when research reports contradictions', () => {
    const result = computeRequiresHumanReview(safeInput({ research: { evidenceGapCount: 0, contradictionCount: 1 } }));
    expect(result.reasons).toContain('CONTRADICTORY_SOURCES');
  });

  it('flags VERIFICATION_NEEDS_REVIEW_OR_BLOCKED for NEEDS_REVIEW or BLOCKED status', () => {
    const needsReview = computeRequiresHumanReview(
      safeInput({ verification: { status: BlogVerificationStatus.NEEDS_REVIEW, hasUnverifiedSemanticClaim: false } }),
    );
    expect(needsReview.reasons).toContain('VERIFICATION_NEEDS_REVIEW_OR_BLOCKED');

    const blocked = computeRequiresHumanReview(
      safeInput({ verification: { status: BlogVerificationStatus.BLOCKED, hasUnverifiedSemanticClaim: false } }),
    );
    expect(blocked.reasons).toContain('VERIFICATION_NEEDS_REVIEW_OR_BLOCKED');

    const passed = computeRequiresHumanReview(
      safeInput({ verification: { status: BlogVerificationStatus.PASSED, hasUnverifiedSemanticClaim: false } }),
    );
    expect(passed.reasons).not.toContain('VERIFICATION_NEEDS_REVIEW_OR_BLOCKED');
  });

  it('flags SEMANTIC_CLAIM_NOT_VERIFIED when verification reports an unverified semantic claim', () => {
    const result = computeRequiresHumanReview(
      safeInput({ verification: { status: BlogVerificationStatus.PASSED, hasUnverifiedSemanticClaim: true } }),
    );
    expect(result.reasons).toContain('SEMANTIC_CLAIM_NOT_VERIFIED');
  });

  it('flags LOW_STRUCTURED_AI_CONFIDENCE only when a confidence value is actually provided and below threshold', () => {
    const below = computeRequiresHumanReview(safeInput({ structuredAiConfidence: DEFAULT_STRUCTURED_AI_CONFIDENCE_THRESHOLD - 1 }));
    expect(below.reasons).toContain('LOW_STRUCTURED_AI_CONFIDENCE');

    const atThreshold = computeRequiresHumanReview(safeInput({ structuredAiConfidence: DEFAULT_STRUCTURED_AI_CONFIDENCE_THRESHOLD }));
    expect(atThreshold.reasons).not.toContain('LOW_STRUCTURED_AI_CONFIDENCE');

    const absent = computeRequiresHumanReview(safeInput());
    expect(absent.reasons).not.toContain('LOW_STRUCTURED_AI_CONFIDENCE');
  });

  it('never evaluates research/verification reasons when that evidence is absent (no fake defaults)', () => {
    const result = computeRequiresHumanReview(safeInput());
    expect(result.reasons).not.toContain('UNRESOLVED_EVIDENCE_GAPS');
    expect(result.reasons).not.toContain('CONTRADICTORY_SOURCES');
    expect(result.reasons).not.toContain('VERIFICATION_NEEDS_REVIEW_OR_BLOCKED');
    expect(result.reasons).not.toContain('SEMANTIC_CLAIM_NOT_VERIFIED');
  });
});

describe('computeRequiresHumanReviewAtCreation', () => {
  it('evaluates purely from creation-time evidence with no research/verification data', () => {
    const result = computeRequiresHumanReviewAtCreation({
      category: 'Compliance Guides',
      requiresOfficialSource: false,
      sourceQuality: BlogSourceQuality.OFFICIAL,
      priority: BlogSuggestionPriority.LOW,
      jurisdiction: 'KE',
    });
    expect(result).toEqual({ required: false, reasons: [] });
  });

  it('derives categoryRequiresOfficialSource from the Regulatory Updates / Enforcement & Penalties rule', () => {
    const result = computeRequiresHumanReviewAtCreation({
      category: 'Regulatory Updates',
      requiresOfficialSource: true, // BlogArticleSuggestion field: true means the linked source is NOT itself official
      sourceQuality: BlogSourceQuality.MEDIUM,
      priority: BlogSuggestionPriority.LOW,
      jurisdiction: 'KE',
    });
    expect(result.required).toBe(true);
    expect(result.reasons).toContain('MISSING_REQUIRED_OFFICIAL_SOURCE');
  });
});
