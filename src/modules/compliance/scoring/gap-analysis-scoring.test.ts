import { describe, it, expect } from 'vitest';
import {
  calculateComplianceAlignmentScore,
  SCORING_VERSION_V2,
  type RequirementAssessment,
  type DocumentCoverage,
} from './gap-analysis-scoring';

function mockAssessment(overrides: Partial<RequirementAssessment>): RequirementAssessment {
  return {
    id: 'req-1',
    frameworkSlug: 'cbk-prudential-guidelines',
    jurisdiction: 'KE',
    requirement: 'Maintain minimum capital adequacy ratio',
    status: 'COMPLIANT',
    severity: 'HIGH',
    severityRationale: 'Statutory capital solvency requirement',
    policyEvidence: [
      {
        policyEvidenceId: 'pol-chunk-1',
        excerpt: 'The company maintains a capital adequacy ratio exceeding 12%',
      },
    ],
    regulatoryEvidence: [
      {
        evidenceId: 'vec-123',
        vectorId: 'vec-123',
        documentId: 'doc-1',
        documentTitle: 'CBK Prudential Guidelines',
        jurisdiction: 'KE',
        frameworkSlug: 'cbk-prudential-guidelines',
        section: 'Part 3',
        excerpt: 'Institutions shall maintain minimum capital ratio of 10.5%',
      },
    ],
    verification: {
      verdict: 'SUPPORTED',
      confidence: 0.95,
    },
    coverage: {
      regulatoryEvidenceAvailable: true,
      policySectionAssessed: true,
      extractionComplete: true,
    },
    ...overrides,
  };
}

const completeDocCoverage: DocumentCoverage = {
  totalChunks: 3,
  processedChunks: 3,
  failedChunks: 0,
  skippedChunks: 0,
  extractionComplete: true,
};

describe('Defensible Compliance Alignment & Coverage Scoring Engine', () => {
  it('does not turn model-selected assessments into coverage when inventory scope is unknown', () => {
    const result = calculateComplianceAlignmentScore({
      assessments: [mockAssessment({ id: 'model-finding', status: 'COMPLIANT' })],
      documentCoverage: completeDocCoverage,
      inventoryCompleteness: 'UNKNOWN',
    });
    expect(result.complianceAlignmentScore).toBe(100);
    expect(result.assessmentCoverageScore).toBe(0);
    expect(result.coverageStatus).toBe('UNKNOWN');
    expect(result.totalCount).toBe(0);
  });

  it('13. Identical validated assessments produce identical score (pure determinism)', () => {
    const assessments = [
      mockAssessment({ id: 'req-1', status: 'COMPLIANT', severity: 'CRITICAL' }),
      mockAssessment({ id: 'req-2', status: 'PARTIAL', severity: 'HIGH' }),
      mockAssessment({ id: 'req-3', status: 'GAP', severity: 'MEDIUM' }),
    ];

    const run1 = calculateComplianceAlignmentScore({
      assessments,
      documentCoverage: completeDocCoverage,
    });
    const run2 = calculateComplianceAlignmentScore({
      assessments,
      documentCoverage: completeDocCoverage,
    });

    expect(run1.complianceAlignmentScore).toBe(run2.complianceAlignmentScore);
    expect(run1.assessmentCoverageScore).toBe(run2.assessmentCoverageScore);
    expect(run1.scoringVersion).toBe(SCORING_VERSION_V2);
  });

  it('FIXTURE A: Policy fully satisfies 5 evidence-backed requirements (Max Alignment & Complete Coverage)', () => {
    const assessments = [
      mockAssessment({ id: 'req-1', status: 'COMPLIANT', severity: 'CRITICAL' }),
      mockAssessment({ id: 'req-2', status: 'COMPLIANT', severity: 'CRITICAL' }),
      mockAssessment({ id: 'req-3', status: 'COMPLIANT', severity: 'HIGH' }),
      mockAssessment({ id: 'req-4', status: 'COMPLIANT', severity: 'MEDIUM' }),
      mockAssessment({ id: 'req-5', status: 'COMPLIANT', severity: 'LOW' }),
    ];

    const result = calculateComplianceAlignmentScore({
      assessments,
      documentCoverage: completeDocCoverage,
    });

    expect(result.complianceAlignmentScore).toBe(100);
    expect(result.assessmentCoverageScore).toBe(100);
    expect(result.coverageStatus).toBe('COMPLETE');
    expect(result.breakdown.compliantCount).toBe(5);
    expect(result.breakdown.gapCount).toBe(0);
  });

  it('FIXTURE B: Policy misses 1 of 5 requirements (Deterministic lower score)', () => {
    // 4 COMPLIANT (Crit: 5, Crit: 5, High: 4, Med: 3 = 17 pts)
    // 1 GAP (Low: 2, score 0 = 0 pts)
    // Total weight = 5 + 5 + 4 + 3 + 2 = 19
    // Alignment = 17 / 19 * 100 = 89.47 -> 89%
    const assessments = [
      mockAssessment({ id: 'req-1', status: 'COMPLIANT', severity: 'CRITICAL' }),
      mockAssessment({ id: 'req-2', status: 'COMPLIANT', severity: 'CRITICAL' }),
      mockAssessment({ id: 'req-3', status: 'COMPLIANT', severity: 'HIGH' }),
      mockAssessment({ id: 'req-4', status: 'COMPLIANT', severity: 'MEDIUM' }),
      mockAssessment({ id: 'req-5', status: 'GAP', severity: 'LOW' }),
    ];

    const result = calculateComplianceAlignmentScore({
      assessments,
      documentCoverage: completeDocCoverage,
    });

    expect(result.complianceAlignmentScore).toBe(89);
    expect(result.assessmentCoverageScore).toBe(100);
    expect(result.coverageStatus).toBe('COMPLETE');
    expect(result.breakdown.compliantCount).toBe(4);
    expect(result.breakdown.gapCount).toBe(1);
  });

  it('FIXTURE C: Only 3 of 5 regulatory requirements have sufficient corpus evidence', () => {
    // 3 assessed (all compliant = 100% of assessed), 2 insufficient evidence
    // Alignment is computed across validly assessed: 100%
    // Coverage is 3 / 5 = 60%, marked INSUFFICIENT
    const assessments = [
      mockAssessment({ id: 'req-1', status: 'COMPLIANT', severity: 'HIGH' }),
      mockAssessment({ id: 'req-2', status: 'COMPLIANT', severity: 'HIGH' }),
      mockAssessment({ id: 'req-3', status: 'COMPLIANT', severity: 'MEDIUM' }),
      mockAssessment({ id: 'req-4', status: 'INSUFFICIENT_EVIDENCE', severity: 'HIGH' }),
      mockAssessment({ id: 'req-5', status: 'INSUFFICIENT_EVIDENCE', severity: 'CRITICAL' }),
    ];

    const result = calculateComplianceAlignmentScore({
      assessments,
      documentCoverage: completeDocCoverage,
      expectedRequirementCount: 5,
    });

    expect(result.complianceAlignmentScore).toBe(100);
    expect(result.assessmentCoverageScore).toBe(60);
    expect(result.coverageStatus).toBe('INSUFFICIENT');
  });

  it('FIXTURE D: Quarantines unsupported verifier claims from score calculation', () => {
    // 1 COMPLIANT (weight 4)
    // 1 GAP with UNSUPPORTED verification (weight 5) -> MUST be quarantined and NOT lower the score!
    const assessments = [
      mockAssessment({ id: 'req-1', status: 'COMPLIANT', severity: 'HIGH', verification: { verdict: 'SUPPORTED' } }),
      mockAssessment({
        id: 'req-2',
        status: 'GAP',
        severity: 'CRITICAL',
        verification: { verdict: 'UNSUPPORTED', unsupportedClaims: ['Hallucinated requirement'] },
      }),
    ];

    const result = calculateComplianceAlignmentScore({
      assessments,
      documentCoverage: completeDocCoverage,
    });

    expect(result.breakdown.unsupportedQuarantinedCount).toBe(1);
    expect(result.breakdown.compliantCount).toBe(1);
    expect(result.breakdown.gapCount).toBe(0);
    expect(result.complianceAlignmentScore).toBe(100); // Only supported assessments count
  });

  it('FIXTURE E: One policy chunk fails processing (incomplete document coverage)', () => {
    const assessments = [
      mockAssessment({ id: 'req-1', status: 'COMPLIANT', severity: 'HIGH' }),
    ];

    const failedDocCoverage: DocumentCoverage = {
      totalChunks: 4,
      processedChunks: 3,
      failedChunks: 1,
      skippedChunks: 0,
      extractionComplete: false,
    };

    const result = calculateComplianceAlignmentScore({
      assessments,
      documentCoverage: failedDocCoverage,
    });

    // 1 chunk failed out of 4: factor = (3 - 1) / 4 = 0.50
    expect(result.documentCoverage.failedChunks).toBe(1);
    expect(result.assessmentCoverageScore).toBeLessThan(100);
    expect(result.coverageStatus).toBe('INSUFFICIENT');
  });

  it('14. Zero gaps with partial framework coverage is NOT 100% coverage', () => {
    const assessments = [
      mockAssessment({ id: 'req-1', status: 'COMPLIANT', severity: 'MEDIUM' }),
    ];

    const result = calculateComplianceAlignmentScore({
      assessments,
      documentCoverage: completeDocCoverage,
      expectedRequirementCount: 5, // Only 1 out of 5 was assessed
    });

    expect(result.complianceAlignmentScore).toBe(100);
    expect(result.assessmentCoverageScore).toBe(20); // 1 / 5 = 20%
    expect(result.coverageStatus).toBe('INSUFFICIENT');
  });

  it('16. Critical gap heavily impacts score compared to low gap', () => {
    const critGapResult = calculateComplianceAlignmentScore({
      assessments: [
        mockAssessment({ id: 'req-1', status: 'COMPLIANT', severity: 'HIGH' }), // 4 pts
        mockAssessment({ id: 'req-2', status: 'GAP', severity: 'CRITICAL' }),   // weight 5, 0 pts
      ],
      documentCoverage: completeDocCoverage,
    });
    // 4 / (4 + 5) = 44%

    const lowGapResult = calculateComplianceAlignmentScore({
      assessments: [
        mockAssessment({ id: 'req-1', status: 'COMPLIANT', severity: 'HIGH' }), // 4 pts
        mockAssessment({ id: 'req-2', status: 'GAP', severity: 'LOW' }),        // weight 2, 0 pts
      ],
      documentCoverage: completeDocCoverage,
    });
    // 4 / (4 + 2) = 67%

    expect(critGapResult.complianceAlignmentScore).toBe(44);
    expect(lowGapResult.complianceAlignmentScore).toBe(67);
    expect(critGapResult.complianceAlignmentScore).toBeLessThan(lowGapResult.complianceAlignmentScore);
  });

  it('17. PARTIAL outcome yields half points (0.5 * weight)', () => {
    const result = calculateComplianceAlignmentScore({
      assessments: [
        mockAssessment({ id: 'req-1', status: 'PARTIAL', severity: 'HIGH' }), // weight 4, score 0.5 * 4 = 2
      ],
      documentCoverage: completeDocCoverage,
    });

    expect(result.complianceAlignmentScore).toBe(50);
  });

  it('18. NOT_ASSESSED lowers coverage without penalizing alignment denominator', () => {
    const result = calculateComplianceAlignmentScore({
      assessments: [
        mockAssessment({ id: 'req-1', status: 'COMPLIANT', severity: 'HIGH' }),
        mockAssessment({ id: 'req-2', status: 'NOT_ASSESSED', severity: 'HIGH' }),
      ],
      documentCoverage: completeDocCoverage,
    });

    expect(result.complianceAlignmentScore).toBe(100);
    expect(result.assessmentCoverageScore).toBe(50); // 1 valid out of 2
    expect(result.breakdown.notAssessedCount).toBe(1);
  });
});
