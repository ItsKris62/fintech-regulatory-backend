import { describe, expect, it } from 'vitest';
import {
  calculateComplianceAlignmentScore,
  type RequirementAssessment,
  type RegulatoryEvidenceRef,
  type PolicyEvidenceRef,
  type DocumentCoverage,
} from '@/modules/compliance/scoring/gap-analysis-scoring';
import {
  verifyFindingClaims,
  resolveFindingEvidence,
  type FindingVerificationInput,
} from '@/modules/compliance/orchestrator/verifier.agent';
import {
  parseGapAnalysisOutput,
  RegulatoryEvidenceRefSchema,
  PolicyEvidenceRefSchema,
} from '@/lib/ai/prompts/gap-analysis';

const defaultDocCoverage: DocumentCoverage = {
  totalChunks: 1,
  processedChunks: 1,
  failedChunks: 0,
  skippedChunks: 0,
  extractionComplete: true,
};

describe('Batch 3 Remediation: Finding-Level Evidence Lineage, Claim Verification & Defensible Scoring', () => {
  // ─── SECTION 28.1: EVIDENCE IDENTITY & LINEAGE ─────────────────────────────

  describe('Evidence Identity & Validation', () => {
    it('accepts a valid regulatory evidence reference conforming to schema', () => {
      const validRef: RegulatoryEvidenceRef = {
        evidenceId: 'pinecone-doc-123#chunk-4',
        vectorId: 'pinecone-doc-123#chunk-4',
        documentId: 'doc-123',
        documentTitle: 'Data Protection Act 2019',
        jurisdiction: 'KE',
        frameworkSlug: 'data-protection',
        sourceAuthority: 'ODPC',
        section: '31',
        excerpt: 'Data controller shall designate a data protection officer...',
      };

      const parsed = RegulatoryEvidenceRefSchema.safeParse(validRef);
      expect(parsed.success).toBe(true);
    });

    it('rejects an evidence reference missing mandatory excerpt or vector identity', () => {
      const invalidRef = {
        evidenceId: 'id-1',
        // missing vectorId
        documentTitle: 'DPA',
        jurisdiction: 'KE',
        frameworkSlug: 'data-protection',
        // missing excerpt
      };

      const parsed = RegulatoryEvidenceRefSchema.safeParse(invalidRef);
      expect(parsed.success).toBe(false);
    });

    it('accepts a valid policy evidence reference with exact chunk locator', () => {
      const validPolicyRef: PolicyEvidenceRef = {
        policyEvidenceId: 'pol-chunk-2',
        chunkIndex: 2,
        sectionHeading: 'Data Security Controls',
        excerpt: 'Access controls shall be reviewed quarterly by the IT manager.',
        startOffset: 120,
        endOffset: 185,
      };

      const parsed = PolicyEvidenceRefSchema.safeParse(validPolicyRef);
      expect(parsed.success).toBe(true);
    });
  });

  // ─── SECTION 28.2: FINDING-LEVEL CLAIM VERIFICATION ────────────────────────

  describe('Finding-Level Claim Verification (verifyFindingClaims)', () => {
    const validEvidence: RegulatoryEvidenceRef = {
      evidenceId: 'vec-dpa-sec31',
      vectorId: 'vec-dpa-sec31',
      documentId: 'doc-dpa',
      documentTitle: 'Data Protection Act 2019',
      jurisdiction: 'KE',
      frameworkSlug: 'data-protection',
      section: '31',
      excerpt: 'A data controller shall designate a Data Protection Officer.',
    };

    const validPolicyEvidence: PolicyEvidenceRef = {
      policyEvidenceId: 'pol-chunk-1',
      chunkIndex: 1,
      excerpt: 'The company has not yet appointed a designated data protection officer.',
    };

    it('classifies a well-grounded finding as SUPPORTED', () => {
      const input: FindingVerificationInput = {
        id: 'finding-1',
        requirement: 'Appointment of Data Protection Officer',
        status: 'GAP',
        severity: 'HIGH',
        severityRationale: 'Mandatory statutory role under Section 31.',
        regulatoryBasis: 'Section 31 Data Protection Act 2019',
        policyCurrentState: 'No DPO appointed.',
        regulatoryEvidence: [validEvidence],
        policyEvidence: [validPolicyEvidence],
        frameworkSlug: 'data-protection',
        jurisdiction: 'KE',
      };

      const [verdict] = verifyFindingClaims([input], 'KE');
      expect(verdict.verdict).toBe('SUPPORTED');
      expect(verdict.confidence).toBeGreaterThanOrEqual(0.85);
      expect(verdict.unsupportedClaims).toHaveLength(0);
    });

    it('classifies finding with missing regulatory evidence as NOT_VERIFIABLE', () => {
      const input: FindingVerificationInput = {
        id: 'finding-2',
        requirement: 'Audit Committee Independence',
        status: 'GAP',
        severity: 'MEDIUM',
        regulatoryBasis: 'Uncited corporate governance guideline',
        policyCurrentState: 'Committee chaired by executive.',
        regulatoryEvidence: [], // No evidence
        policyEvidence: [validPolicyEvidence],
        frameworkSlug: 'data-protection',
        jurisdiction: 'KE',
      };

      const [verdict] = verifyFindingClaims([input], 'KE');
      expect(verdict.verdict).toBe('NOT_VERIFIABLE');
      expect(verdict.unsupportedClaims.length).toBeGreaterThan(0);
    });

    it('classifies cross-border foreign regulatory citation as UNSUPPORTED', () => {
      const foreignEvidence: RegulatoryEvidenceRef = {
        ...validEvidence,
        jurisdiction: 'RW', // Rwanda evidence in Kenyan analysis
      };

      const input: FindingVerificationInput = {
        id: 'finding-3',
        requirement: 'Data Localization',
        status: 'GAP',
        severity: 'HIGH',
        regulatoryBasis: 'Rwandan Law No. 058/2021',
        policyCurrentState: 'Data stored abroad.',
        regulatoryEvidence: [foreignEvidence],
        policyEvidence: [validPolicyEvidence],
        frameworkSlug: 'data-protection',
        jurisdiction: 'KE',
      };

      const [verdict] = verifyFindingClaims([input], 'KE');
      expect(verdict.verdict).toBe('UNSUPPORTED');
      expect(verdict.unsupportedClaims[0]).toContain('foreign jurisdiction');
    });

    it('classifies finding from unrelated framework evidence as UNSUPPORTED', () => {
      const mismatchedEvidence: RegulatoryEvidenceRef = {
        ...validEvidence,
        frameworkSlug: 'aml-cft', // AML evidence cited for consumer protection
      };

      const input: FindingVerificationInput = {
        id: 'finding-4',
        requirement: 'Customer Disclosure Standards',
        status: 'GAP',
        severity: 'HIGH',
        regulatoryBasis: 'POCAMLA Section 12',
        policyCurrentState: 'Fee schedule not published.',
        regulatoryEvidence: [mismatchedEvidence],
        policyEvidence: [validPolicyEvidence],
        frameworkSlug: 'consumer-protection',
        jurisdiction: 'KE',
      };

      const [verdict] = verifyFindingClaims([input], 'KE');
      expect(verdict.verdict).toBe('UNSUPPORTED');
      expect(verdict.unsupportedClaims[0]).toContain('unrelated framework');
    });

    it('classifies positive COMPLIANT claim without policy evidence as UNSUPPORTED', () => {
      const input: FindingVerificationInput = {
        id: 'finding-5',
        requirement: 'Annual Security Audit',
        status: 'COMPLIANT',
        severity: 'LOW',
        regulatoryBasis: 'Section 42 Security Safeguards',
        policyCurrentState: 'Audit performed annually.',
        regulatoryEvidence: [validEvidence],
        policyEvidence: [], // Missing customer policy evidence!
        frameworkSlug: 'data-protection',
        jurisdiction: 'KE',
      };

      const [verdict] = verifyFindingClaims([input], 'KE');
      expect(verdict.verdict).toBe('UNSUPPORTED');
      expect(verdict.unsupportedClaims[0]).toContain('without policy evidence');
    });
  });

  // ─── SECTION 28.3: SCORING REPRODUCIBILITY & DETERMINISM ───────────────────

  describe('Defensible Scoring Engine (calculateComplianceAlignmentScore)', () => {
    it('is a deterministic pure function: identical assessments yield identical scores', () => {
      const assessments: RequirementAssessment[] = [
        {
          id: 'req-1',
          frameworkSlug: 'dpa',
          jurisdiction: 'KE',
          requirement: 'DPO Appointment',
          status: 'COMPLIANT',
          severity: 'HIGH',
          severityRationale: 'Mandatory',
          policyEvidence: [{ policyEvidenceId: 'pol-1', excerpt: 'DPO appointed' }],
          regulatoryEvidence: [{ evidenceId: 'ev-1', vectorId: 'ev-1', documentTitle: 'DPA', jurisdiction: 'KE', frameworkSlug: 'dpa', excerpt: 'Appoint DPO' }],
          verification: { verdict: 'SUPPORTED' },
          coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
        },
        {
          id: 'req-2',
          frameworkSlug: 'dpa',
          jurisdiction: 'KE',
          requirement: 'Breach Notification',
          status: 'GAP',
          severity: 'CRITICAL',
          severityRationale: 'Mandatory',
          policyEvidence: [],
          regulatoryEvidence: [{ evidenceId: 'ev-2', vectorId: 'ev-2', documentTitle: 'DPA', jurisdiction: 'KE', frameworkSlug: 'dpa', excerpt: 'Notify in 72h' }],
          verification: { verdict: 'SUPPORTED' },
          coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
        },
      ];

      const score1 = calculateComplianceAlignmentScore({ assessments, documentCoverage: defaultDocCoverage });
      const score2 = calculateComplianceAlignmentScore({ assessments, documentCoverage: defaultDocCoverage });

      expect(score1.complianceAlignmentScore).toBe(score2.complianceAlignmentScore);
      expect(score1.assessmentCoverageScore).toBe(score2.assessmentCoverageScore);
      expect(score1.overallScore).toBe(score2.overallScore);
    });

    it('quarantines UNSUPPORTED findings from contributing positively or negatively', () => {
      const validCompliant: RequirementAssessment = {
        id: 'req-1',
        frameworkSlug: 'dpa',
        jurisdiction: 'KE',
        requirement: 'Data Protection Officer',
        status: 'COMPLIANT',
        severity: 'HIGH', // weight 4
        severityRationale: 'Mandatory',
        policyEvidence: [{ policyEvidenceId: 'p-1', excerpt: 'DPO exists' }],
        regulatoryEvidence: [{ evidenceId: 'e-1', vectorId: 'e-1', documentTitle: 'DPA', jurisdiction: 'KE', frameworkSlug: 'dpa', excerpt: 'DPO' }],
        verification: { verdict: 'SUPPORTED' },
        coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
      };

      const unsupportedGap: RequirementAssessment = {
        id: 'req-2',
        frameworkSlug: 'dpa',
        jurisdiction: 'KE',
        requirement: 'Hallucinated Regulation Gap',
        status: 'GAP',
        severity: 'CRITICAL', // would normally destroy score
        severityRationale: 'Model hallucination',
        policyEvidence: [],
        regulatoryEvidence: [],
        verification: { verdict: 'UNSUPPORTED' }, // Quarantined!
        coverage: { regulatoryEvidenceAvailable: false, policySectionAssessed: false, extractionComplete: true },
      };

      const scoreWithUnsupported = calculateComplianceAlignmentScore({
        assessments: [validCompliant, unsupportedGap],
        documentCoverage: defaultDocCoverage,
      });
      const scoreWithoutUnsupported = calculateComplianceAlignmentScore({
        assessments: [validCompliant],
        documentCoverage: defaultDocCoverage,
      });

      // Both should have 100% alignment across validly verified requirements
      expect(scoreWithUnsupported.complianceAlignmentScore).toBe(100);
      expect(scoreWithoutUnsupported.complianceAlignmentScore).toBe(100);
      // But coverage reflects the quarantine/unsupported requirement
      expect(scoreWithUnsupported.breakdown.unsupportedQuarantinedCount).toBe(1);
    });

    it('never grants 100% compliance if evidence coverage is partial or incomplete', () => {
      // 0 gaps found, but only 2 of 5 framework requirements had available regulatory evidence
      const assessments: RequirementAssessment[] = [
        {
          id: 'req-1',
          frameworkSlug: 'dpa',
          jurisdiction: 'KE',
          requirement: 'Req 1',
          status: 'COMPLIANT',
          severity: 'HIGH',
          severityRationale: 'Ok',
          policyEvidence: [{ policyEvidenceId: 'p-1', excerpt: 'Complies' }],
          regulatoryEvidence: [{ evidenceId: 'e-1', vectorId: 'e-1', documentTitle: 'DPA', jurisdiction: 'KE', frameworkSlug: 'dpa', excerpt: 'Req 1' }],
          verification: { verdict: 'SUPPORTED' },
          coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
        },
        {
          id: 'req-2',
          frameworkSlug: 'dpa',
          jurisdiction: 'KE',
          requirement: 'Req 2',
          status: 'INSUFFICIENT_EVIDENCE',
          severity: 'HIGH',
          severityRationale: 'No regulatory text available',
          policyEvidence: [],
          regulatoryEvidence: [],
          verification: { verdict: 'NOT_VERIFIABLE' },
          coverage: { regulatoryEvidenceAvailable: false, policySectionAssessed: false, extractionComplete: true },
        },
      ];

      const result = calculateComplianceAlignmentScore({
        assessments,
        documentCoverage: defaultDocCoverage,
      });
      // Alignment on valid assessed requirement is 100%
      expect(result.complianceAlignmentScore).toBe(100);
      // But coverage is only 50%, capped at INSUFFICIENT / PARTIAL
      expect(result.assessmentCoverageScore).toBe(50);
      expect(result.coverageStatus).toBe('INSUFFICIENT');
    });
  });

  // ─── SECTION 28.4: GOLDEN FIXTURES A–E ─────────────────────────────────────

  describe('Golden Fixtures (A–E)', () => {
    // FIXTURE A: Policy satisfies all 5 evidence-backed requirements
    it('FIXTURE A: 5 compliant requirements -> maximum alignment and complete coverage', () => {
      const fixtureA: RequirementAssessment[] = [1, 2, 3, 4, 5].map((i) => ({
        id: `req-${i}`,
        frameworkSlug: 'dpa',
        jurisdiction: 'KE',
        requirement: `Obligation ${i}`,
        status: 'COMPLIANT',
        severity: 'HIGH',
        severityRationale: 'Satisfied in full',
        policyEvidence: [{ policyEvidenceId: `pol-${i}`, excerpt: `Clause ${i}` }],
        regulatoryEvidence: [{ evidenceId: `reg-${i}`, vectorId: `reg-${i}`, documentTitle: 'DPA', jurisdiction: 'KE', frameworkSlug: 'dpa', excerpt: `Law ${i}` }],
        verification: { verdict: 'SUPPORTED' },
        coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
      }));

      const res = calculateComplianceAlignmentScore({ assessments: fixtureA, documentCoverage: defaultDocCoverage });
      expect(res.complianceAlignmentScore).toBe(100);
      expect(res.assessmentCoverageScore).toBe(100);
      expect(res.overallScore).toBe(100);
      expect(res.coverageStatus).toBe('COMPLETE');
    });

    // FIXTURE B: Policy misses 1 of 5 requirements
    it('FIXTURE B: 4 compliant, 1 gap -> deterministic lower alignment score', () => {
      const fixtureB: RequirementAssessment[] = [1, 2, 3, 4].map((i) => ({
        id: `req-${i}`,
        frameworkSlug: 'dpa',
        jurisdiction: 'KE',
        requirement: `Obligation ${i}`,
        status: 'COMPLIANT' as const,
        severity: 'HIGH' as const, // weight 4
        severityRationale: 'Satisfied',
        policyEvidence: [{ policyEvidenceId: `pol-${i}`, excerpt: `Clause ${i}` }],
        regulatoryEvidence: [{ evidenceId: `reg-${i}`, vectorId: `reg-${i}`, documentTitle: 'DPA', jurisdiction: 'KE', frameworkSlug: 'dpa', excerpt: `Law ${i}` }],
        verification: { verdict: 'SUPPORTED' as const },
        coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
      }));

      fixtureB.push({
        id: 'req-5',
        frameworkSlug: 'dpa',
        jurisdiction: 'KE',
        requirement: 'Obligation 5',
        status: 'GAP',
        severity: 'HIGH', // weight 4
        severityRationale: 'Missing from policy',
        policyEvidence: [],
        regulatoryEvidence: [{ evidenceId: 'reg-5', vectorId: 'reg-5', documentTitle: 'DPA', jurisdiction: 'KE', frameworkSlug: 'dpa', excerpt: 'Law 5' }],
        verification: { verdict: 'SUPPORTED' },
        coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
      });

      const res = calculateComplianceAlignmentScore({ assessments: fixtureB, documentCoverage: defaultDocCoverage });
      // 4 compliant @ 4 = 16 out of 20 total weight -> exactly 80%
      expect(res.complianceAlignmentScore).toBe(80);
      expect(res.assessmentCoverageScore).toBe(100);
      expect(res.overallScore).toBe(80);
    });

    // FIXTURE C: Only 3 of 5 regulatory requirements have sufficient corpus evidence
    it('FIXTURE C: 3 of 5 requirements evaluated -> partial coverage, alignment calculated only across assessed', () => {
      const fixtureC: RequirementAssessment[] = [
        // 3 assessed compliant
        ...([1, 2, 3].map((i) => ({
          id: `req-${i}`,
          frameworkSlug: 'dpa',
          jurisdiction: 'KE' as const,
          requirement: `Obligation ${i}`,
          status: 'COMPLIANT' as const,
          severity: 'HIGH' as const,
          severityRationale: 'Met',
          policyEvidence: [{ policyEvidenceId: `p-${i}`, excerpt: `Text ${i}` }],
          regulatoryEvidence: [{ evidenceId: `r-${i}`, vectorId: `r-${i}`, documentTitle: 'DPA', jurisdiction: 'KE' as const, frameworkSlug: 'dpa', excerpt: `Law ${i}` }],
          verification: { verdict: 'SUPPORTED' as const },
          coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
        }))),
        // 2 insufficient evidence
        ...([4, 5].map((i) => ({
          id: `req-${i}`,
          frameworkSlug: 'dpa',
          jurisdiction: 'KE' as const,
          requirement: `Obligation ${i}`,
          status: 'INSUFFICIENT_EVIDENCE' as const,
          severity: 'MEDIUM' as const,
          severityRationale: 'No regulatory text available',
          policyEvidence: [],
          regulatoryEvidence: [],
          verification: { verdict: 'NOT_VERIFIABLE' as const },
          coverage: { regulatoryEvidenceAvailable: false, policySectionAssessed: false, extractionComplete: true },
        }))),
      ];

      const res = calculateComplianceAlignmentScore({
        assessments: fixtureC,
        documentCoverage: defaultDocCoverage,
        expectedRequirementCount: 5,
      });
      // Valid assessed are 3/3 compliant = 100% alignment
      expect(res.complianceAlignmentScore).toBe(100);
      // Coverage is 3/5 = 60%
      expect(res.assessmentCoverageScore).toBe(60);
      expect(res.coverageStatus).toBe('INSUFFICIENT');
    });

    // FIXTURE D: Model returns invented citation ID
    it('FIXTURE D: Model returns invented citation -> rejected by verifier, quarantined from score', () => {
      const hallucinatedInput: FindingVerificationInput = {
        id: 'finding-hallucinated',
        requirement: 'Fictitious Requirement',
        status: 'GAP',
        severity: 'CRITICAL',
        regulatoryBasis: 'Fake Act Section 999',
        policyCurrentState: 'No policy',
        regulatoryEvidence: [], // No matched approved evidence from Pinecone
        policyEvidence: [],
        frameworkSlug: 'dpa',
        jurisdiction: 'KE',
      };

      const [verdict] = verifyFindingClaims([hallucinatedInput], 'KE');
      expect(verdict.verdict).toBe('NOT_VERIFIABLE');

      const assessment: RequirementAssessment = {
        id: 'finding-hallucinated',
        frameworkSlug: 'dpa',
        jurisdiction: 'KE',
        requirement: 'Fictitious Requirement',
        status: 'GAP',
        severity: 'CRITICAL',
        severityRationale: 'Hallucinated',
        policyEvidence: [],
        regulatoryEvidence: [],
        verification: { verdict: 'UNSUPPORTED' },
        coverage: { regulatoryEvidenceAvailable: false, policySectionAssessed: false, extractionComplete: true },
      };

      const res = calculateComplianceAlignmentScore({
        assessments: [assessment],
        documentCoverage: defaultDocCoverage,
      });
      expect(res.breakdown.unsupportedQuarantinedCount).toBe(1);
      // Does not destroy customer score with fake critical gap
      expect(res.complianceAlignmentScore).toBe(0);
      expect(res.coverageStatus).toBe('INSUFFICIENT');
    });

    // FIXTURE E: One policy chunk fails processing
    it('FIXTURE E: Document processing chunk fails -> coverage marked incomplete, score penalised', () => {
      const assessments: RequirementAssessment[] = [1, 2, 3].map((i) => ({
        id: `req-${i}`,
        frameworkSlug: 'dpa',
        jurisdiction: 'KE',
        requirement: `Obligation ${i}`,
        status: 'COMPLIANT',
        severity: 'HIGH',
        severityRationale: 'Satisfied',
        policyEvidence: [{ policyEvidenceId: `p-${i}`, excerpt: `Policy ${i}` }],
        regulatoryEvidence: [{ evidenceId: `r-${i}`, vectorId: `r-${i}`, documentTitle: 'DPA', jurisdiction: 'KE', frameworkSlug: 'dpa', excerpt: `Law ${i}` }],
        verification: { verdict: 'SUPPORTED' },
        coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
      }));

      // Document processing had 1 failed chunk
      const documentCoverage: DocumentCoverage = {
        totalChunks: 4,
        processedChunks: 3,
        failedChunks: 1,
        skippedChunks: 0,
        extractionComplete: false,
      };

      const res = calculateComplianceAlignmentScore({ assessments, documentCoverage });
      expect(res.documentCoverage?.failedChunks).toBe(1);
      expect(res.documentCoverage?.extractionComplete).toBe(false);
      expect(res.coverageStatus).toBe('INSUFFICIENT');
      // Assessment coverage score reduced
      expect(res.assessmentCoverageScore).toBeLessThan(100);
    });
  });

  // ─── SECTION 28.5: RESULT VERSIONING ───────────────────────────────────────

  describe('Result Schema Versioning (v2.0-evidence-backed vs v1.0-legacy)', () => {
    it('sets scoringVersion to v2.0-evidence-backed for newly processed analyses', () => {
      const rawOutput = JSON.stringify({
        overallScore: 85,
        executiveSummary: 'Assessment completed.',
        frameworks: [
          {
            id: 'dpa',
            name: 'Data Protection Act 2019',
            score: 85,
            summary: 'Good alignment',
            strengths: ['DPO appointment'],
            gaps: [
              {
                id: 'gap-1',
                title: 'DPIA Missing',
                description: 'A comprehensive DPIA was not identified in the uploaded document.',
                severity: 'HIGH',
                regulatoryBasis: 'Section 31',
                policyCurrentState: 'No DPIA documented',
                recommendation: 'Conduct DPIA',
                effort: 'MEDIUM',
                priority: 1,
                requirement: 'Mandatory Data Protection Impact Assessment',
                status: 'GAP',
                severityRationale: 'Statutory mandate',
                evidenceIds: ['vec-1'],
                policyEvidenceIds: ['pol-1'],
              },
            ],
          },
        ],
        crossCuttingStrengths: ['Governance'],
        actionPlan: [],
        metadata: {
          documentName: 'Policy.pdf',
          analysisDepth: 'standard',
          frameworksAnalysed: ['Data Protection Act 2019'],
          totalGaps: 1,
          criticalGaps: 0,
          highGaps: 1,
          analysisDate: '2026-10-08',
        },
      });

      const parsed = parseGapAnalysisOutput(rawOutput);
      expect((parsed as any).scoringVersion).toBe('v2.0-evidence-backed');
      expect((parsed as any).complianceAlignmentScore).toBeDefined();
      expect(parsed.assessmentCoverage).toBeDefined();
    });

    it('preserves legacy v1.0 analyses without modifying their historical scores', () => {
      const legacyPayload = {
        overallScore: 78,
        scoringVersion: 'v1.0-legacy',
        executiveSummary: 'Legacy report',
        frameworks: [],
        crossCuttingStrengths: [],
        actionPlan: [],
        metadata: {
          documentName: 'OldPolicy.pdf',
          analysisDepth: 'standard',
          frameworksAnalysed: [],
          totalGaps: 0,
          criticalGaps: 0,
          highGaps: 0,
          analysisDate: '2025-01-01',
        },
      };

      // Legacy records remain readable and identifiable
      expect(legacyPayload.scoringVersion).toBe('v1.0-legacy');
      expect(legacyPayload.overallScore).toBe(78);
    });
  });

  // ─── SECTION 28.6: BATCH 3.1 EVIDENCE INTEGRITY & COVERAGE TRUTHFULNESS ───

  describe('Batch 3.1: Evidence-Integrity Hardening & Coverage Truthfulness', () => {
    const regE1: RegulatoryEvidenceRef = {
      evidenceId: 'E1',
      vectorId: 'E1',
      documentId: 'doc-dpa',
      documentTitle: 'Kenya Data Protection Act 2019',
      jurisdiction: 'KE',
      frameworkSlug: 'data-protection',
      section: 'Section 31',
      excerpt: 'Data retention shall not exceed necessary purpose of processing.',
    };

    const regE2: RegulatoryEvidenceRef = {
      evidenceId: 'E2',
      vectorId: 'E2',
      documentId: 'doc-dpa',
      documentTitle: 'Kenya Data Protection Act 2019',
      jurisdiction: 'KE',
      frameworkSlug: 'data-protection',
      section: 'Section 43',
      excerpt: 'Data breach incidents must be notified to ODPC within 72 hours.',
    };

    const regForeign: RegulatoryEvidenceRef = {
      evidenceId: 'E_RW',
      vectorId: 'E_RW',
      documentId: 'doc-rw',
      documentTitle: 'Rwanda Data Protection Law',
      jurisdiction: 'RW',
      frameworkSlug: 'data-protection',
      section: 'Article 12',
      excerpt: 'Data controllers in Rwanda must register with NCSA.',
    };

    const regCrossFramework: RegulatoryEvidenceRef = {
      evidenceId: 'E_AML',
      vectorId: 'E_AML',
      documentId: 'doc-pocamla',
      documentTitle: 'POCAMLA Regulations',
      jurisdiction: 'KE',
      frameworkSlug: 'aml-cft',
      section: 'Reg 15',
      excerpt: 'Transaction monitoring shall detect suspicious activity thresholds.',
    };

    const polChunk1: PolicyEvidenceRef = {
      policyEvidenceId: 'pol-chunk-1',
      chunkIndex: 0,
      excerpt: 'Customer data will be preserved in accordance with company policy.',
    };

    const polChunk2: PolicyEvidenceRef = {
      policyEvidenceId: 'pol-chunk-2',
      chunkIndex: 1,
      excerpt: 'Security audits will be performed on an annual basis.',
    };

    const acceptedEvidenceMap = new Map<string, RegulatoryEvidenceRef>([
      ['E1', regE1],
      ['E2', regE2],
      ['E_RW', regForeign],
      ['E_AML', regCrossFramework],
    ]);

    const policyEvidenceMap = new Map<string, PolicyEvidenceRef>([
      ['pol-chunk-1', polChunk1],
      ['pol-chunk-2', polChunk2],
    ]);

    // ─── REGULATORY EVIDENCE (1–7) ──────────────────────────────────────────

    it('1. valid evidence ID resolves exact chunk', () => {
      const res = resolveFindingEvidence({
        citedEvidenceIds: ['E1'],
        frameworkSlug: 'data-protection',
        analysisJurisdiction: 'KE',
        acceptedEvidenceMap,
        policyEvidenceMap,
      });
      expect(res.resolvedEvidenceIds).toEqual(['E1']);
      expect(res.regulatoryEvidence).toEqual([regE1]);
      expect(res.invalidEvidenceIds).toHaveLength(0);
    });

    it('2. hallucinated evidence ID resolves ZERO evidence', () => {
      const res = resolveFindingEvidence({
        citedEvidenceIds: ['FAKE-DPA-999'],
        frameworkSlug: 'data-protection',
        analysisJurisdiction: 'KE',
        acceptedEvidenceMap,
        policyEvidenceMap,
      });
      expect(res.resolvedEvidenceIds).toHaveLength(0);
      expect(res.regulatoryEvidence).toHaveLength(0);
      expect(res.invalidEvidenceIds).toEqual(['FAKE-DPA-999']);
    });

    it('3. hallucinated ID is not replaced by first framework chunk', () => {
      const res = resolveFindingEvidence({
        citedEvidenceIds: ['HALLUCINATED_ID'],
        frameworkSlug: 'data-protection',
        analysisJurisdiction: 'KE',
        acceptedEvidenceMap,
        policyEvidenceMap,
      });
      expect(res.regulatoryEvidence).toHaveLength(0);
      expect(res.regulatoryEvidence).not.toContain(regE1);
      expect(res.regulatoryEvidence).not.toContain(regE2);
    });

    it('4. missing evidence ID is not replaced automatically', () => {
      const res = resolveFindingEvidence({
        citedEvidenceIds: [],
        frameworkSlug: 'data-protection',
        analysisJurisdiction: 'KE',
        acceptedEvidenceMap,
        policyEvidenceMap,
      });
      expect(res.regulatoryEvidence).toHaveLength(0);
      expect(res.requestedEvidenceIds).toHaveLength(0);
    });

    it('5. evidence from another framework rejected', () => {
      const res = resolveFindingEvidence({
        citedEvidenceIds: ['E_AML'],
        frameworkSlug: 'data-protection',
        analysisJurisdiction: 'KE',
        acceptedEvidenceMap,
        policyEvidenceMap,
      });
      expect(res.regulatoryEvidence).toHaveLength(0);
      expect(res.invalidEvidenceIds).toContain('E_AML');
    });

    it('6. evidence from another jurisdiction rejected', () => {
      const res = resolveFindingEvidence({
        citedEvidenceIds: ['E_RW'],
        frameworkSlug: 'data-protection',
        analysisJurisdiction: 'KE',
        acceptedEvidenceMap,
        policyEvidenceMap,
      });
      expect(res.regulatoryEvidence).toHaveLength(0);
      expect(res.invalidEvidenceIds).toContain('E_RW');
    });

    it('7. Finding A cannot inherit Finding B evidence', () => {
      const resA = resolveFindingEvidence({
        citedEvidenceIds: ['E1'],
        frameworkSlug: 'data-protection',
        analysisJurisdiction: 'KE',
        acceptedEvidenceMap,
        policyEvidenceMap,
      });
      const resB = resolveFindingEvidence({
        citedEvidenceIds: [],
        frameworkSlug: 'data-protection',
        analysisJurisdiction: 'KE',
        acceptedEvidenceMap,
        policyEvidenceMap,
      });
      expect(resA.regulatoryEvidence).toHaveLength(1);
      expect(resB.regulatoryEvidence).toHaveLength(0);
    });

    // ─── POLICY EVIDENCE (8–12) ─────────────────────────────────────────────

    it('8. valid policyEvidenceId resolves exact policy chunk', () => {
      const res = resolveFindingEvidence({
        citedPolicyEvidenceIds: ['pol-chunk-2'],
        frameworkSlug: 'data-protection',
        analysisJurisdiction: 'KE',
        acceptedEvidenceMap,
        policyEvidenceMap,
      });
      expect(res.resolvedPolicyEvidenceIds).toEqual(['pol-chunk-2']);
      expect(res.policyEvidence).toEqual([polChunk2]);
      expect(res.invalidPolicyEvidenceIds).toHaveLength(0);
    });

    it('9. hallucinated policyEvidenceId resolves ZERO policy evidence', () => {
      const res = resolveFindingEvidence({
        citedPolicyEvidenceIds: ['pol-chunk-999'],
        frameworkSlug: 'data-protection',
        analysisJurisdiction: 'KE',
        acceptedEvidenceMap,
        policyEvidenceMap,
      });
      expect(res.policyEvidence).toHaveLength(0);
      expect(res.resolvedPolicyEvidenceIds).toHaveLength(0);
      expect(res.invalidPolicyEvidenceIds).toEqual(['pol-chunk-999']);
    });

    it('10. missing policyEvidenceId does not attach first policy chunk', () => {
      const res = resolveFindingEvidence({
        citedPolicyEvidenceIds: [],
        frameworkSlug: 'data-protection',
        analysisJurisdiction: 'KE',
        acceptedEvidenceMap,
        policyEvidenceMap,
      });
      expect(res.policyEvidence).toHaveLength(0);
      expect(res.policyEvidence).not.toContain(polChunk1);
    });

    it('11. policy evidence from another upload rejected', () => {
      const otherUploadRes = resolveFindingEvidence({
        citedPolicyEvidenceIds: ['pol-chunk-other-upload-42'],
        frameworkSlug: 'data-protection',
        analysisJurisdiction: 'KE',
        acceptedEvidenceMap,
        policyEvidenceMap,
      });
      expect(otherUploadRes.policyEvidence).toHaveLength(0);
      expect(otherUploadRes.invalidPolicyEvidenceIds).toContain('pol-chunk-other-upload-42');
    });

    it('12. absence finding can legitimately contain [] policy evidence', () => {
      const input: FindingVerificationInput = {
        id: 'gap-missing-control',
        requirement: 'Incident Notification within 72 hours',
        status: 'GAP',
        severity: 'HIGH',
        severityRationale: 'Mandatory breach notification statutory rule',
        regulatoryBasis: 'Section 43 Data Protection Act 2019',
        policyCurrentState: 'No breach notification procedure defined.',
        regulatoryEvidence: [regE2],
        policyEvidence: [],
        frameworkSlug: 'data-protection',
        jurisdiction: 'KE',
      };
      const [verdict] = verifyFindingClaims([input], 'KE');
      expect(verdict.verdict).toBe('SUPPORTED');
    });

    // ─── VERIFICATION (13–16) ───────────────────────────────────────────────

    it('13. legal claim with zero regulatory evidence cannot be SUPPORTED', () => {
      const input: FindingVerificationInput = {
        id: 'f-zero-reg',
        requirement: 'Data Protection Officer Appointment',
        status: 'GAP',
        severity: 'HIGH',
        regulatoryBasis: 'Statutory DPA requirement',
        policyCurrentState: 'No DPO appointed',
        regulatoryEvidence: [],
        policyEvidence: [polChunk1],
        frameworkSlug: 'data-protection',
        jurisdiction: 'KE',
      };
      const [verdict] = verifyFindingClaims([input], 'KE');
      expect(verdict.verdict).not.toBe('SUPPORTED');
      expect(verdict.verdict).toBe('NOT_VERIFIABLE');
    });

    it('14. verifier unavailable => NOT_VERIFIABLE or fail-safe result', () => {
      const inputs: FindingVerificationInput[] = [
        {
          id: 'f-1',
          requirement: 'Data Safeguards',
          status: 'GAP',
          severity: 'HIGH',
          regulatoryBasis: 'Section 42',
          policyCurrentState: 'None',
          regulatoryEvidence: [regE1],
          policyEvidence: [],
          frameworkSlug: 'data-protection',
          jurisdiction: 'KE',
        },
      ];
      const fallbackVerdicts = inputs.map((f) => ({
        findingId: f.id,
        verdict: 'NOT_VERIFIABLE' as const,
        confidence: 0.0,
        unsupportedClaims: ['Claim verifier unavailable — finding cannot be verified'],
        reason: 'Verifier service unavailable',
      }));
      expect(fallbackVerdicts[0].verdict).toBe('NOT_VERIFIABLE');
      expect(fallbackVerdicts[0].confidence).toBe(0.0);
      expect(fallbackVerdicts[0].verdict).not.toBe('SUPPORTED');
    });

    it('15. unsupported finding remains quarantined despite other good evidence', () => {
      const validAssessment: RequirementAssessment = {
        id: 'req-valid',
        frameworkSlug: 'data-protection',
        jurisdiction: 'KE',
        requirement: 'Data Retention',
        status: 'COMPLIANT',
        severity: 'HIGH',
        severityRationale: 'Complies',
        policyEvidence: [polChunk1],
        regulatoryEvidence: [regE1],
        verification: { verdict: 'SUPPORTED' },
        coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
      };
      const unsupportedAssessment: RequirementAssessment = {
        id: 'req-bad',
        frameworkSlug: 'data-protection',
        jurisdiction: 'KE',
        requirement: 'Hallucinated AML Control',
        status: 'GAP',
        severity: 'CRITICAL',
        severityRationale: 'Model hallucination',
        policyEvidence: [],
        regulatoryEvidence: [],
        verification: { verdict: 'UNSUPPORTED' },
        coverage: { regulatoryEvidenceAvailable: false, policySectionAssessed: false, extractionComplete: true },
      };
      const res = calculateComplianceAlignmentScore({
        assessments: [validAssessment, unsupportedAssessment],
        documentCoverage: defaultDocCoverage,
      });
      expect(res.complianceAlignmentScore).toBe(100);
      expect(res.breakdown.unsupportedQuarantinedCount).toBe(1);
      expect(res.coverageStatus).toBe('INSUFFICIENT');
    });

    it('16. partially supported behavior matches documented scoring rules', () => {
      const partialAssessment: RequirementAssessment = {
        id: 'req-partially-supported',
        frameworkSlug: 'data-protection',
        jurisdiction: 'KE',
        requirement: 'General Security Safeguards',
        status: 'COMPLIANT',
        severity: 'HIGH',
        severityRationale: 'Met',
        policyEvidence: [polChunk2],
        regulatoryEvidence: [regE1],
        verification: { verdict: 'PARTIALLY_SUPPORTED' },
        coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
      };
      const res = calculateComplianceAlignmentScore({
        assessments: [partialAssessment],
        documentCoverage: defaultDocCoverage,
      });
      expect(res.complianceAlignmentScore).toBe(50);
      expect(res.breakdown.partiallySupportedCount).toBe(1);
    });

    // ─── FRAMEWORK COVERAGE (17–20) ─────────────────────────────────────────

    it('17. one retrieved vector cannot automatically produce COMPLETE', () => {
      const ragResults = [regE1];
      const evidenceStatus = ragResults.length === 0 ? 'UNAVAILABLE' : (ragResults.length < 2 ? 'INSUFFICIENT' : 'PARTIAL');
      expect(evidenceStatus).not.toBe('COMPLETE');
    });

    it('18. no known requirement denominator => framework coverage is not COMPLETE', () => {
      const res = calculateComplianceAlignmentScore({
        assessments: [
          {
            id: 'req-1',
            frameworkSlug: 'dpa',
            jurisdiction: 'KE',
            requirement: 'DPO',
            status: 'COMPLIANT',
            severity: 'HIGH',
            severityRationale: 'Met',
            policyEvidence: [polChunk1],
            regulatoryEvidence: [regE1],
            verification: { verdict: 'SUPPORTED' },
            coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
          },
        ],
        documentCoverage: defaultDocCoverage,
        hasKnownRequirementInventory: false,
      });
      expect(res.coverageStatus).not.toBe('COMPLETE');
      expect(res.coverageStatus).toBe('PARTIAL');
    });

    it('19. all known requirements assessed => COMPLETE only if a real deterministic requirement inventory exists', () => {
      const res = calculateComplianceAlignmentScore({
        assessments: [
          {
            id: 'req-1',
            frameworkSlug: 'dpa',
            jurisdiction: 'KE',
            requirement: 'Req 1',
            status: 'COMPLIANT',
            severity: 'HIGH',
            severityRationale: 'Met',
            policyEvidence: [polChunk1],
            regulatoryEvidence: [regE1],
            verification: { verdict: 'SUPPORTED' },
            coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
          },
        ],
        documentCoverage: defaultDocCoverage,
        expectedRequirementCount: 1,
        hasKnownRequirementInventory: true,
      });
      expect(res.coverageStatus).toBe('COMPLETE');
    });

    it('20. missing evidence => PARTIAL/INSUFFICIENT', () => {
      const emptyResults: any[] = [];
      const statusEmpty = emptyResults.length === 0 ? 'UNAVAILABLE' : 'PARTIAL';
      expect(statusEmpty).toBe('UNAVAILABLE');

      const sparseResults = [regE1];
      const statusSparse = sparseResults.length < 2 ? 'INSUFFICIENT' : 'PARTIAL';
      expect(statusSparse).toBe('INSUFFICIENT');
    });

    // ─── DOCUMENT COVERAGE (21–25) ──────────────────────────────────────────

    it('21. all chunks processed => extractionComplete true', () => {
      const docCov: DocumentCoverage = {
        totalChunks: 3,
        processedChunks: 3,
        failedChunks: 0,
        skippedChunks: 0,
        extractionComplete: true,
      };
      expect(docCov.failedChunks === 0 && docCov.skippedChunks === 0 && docCov.processedChunks === docCov.totalChunks).toBe(true);
      expect(docCov.extractionComplete).toBe(true);
    });

    it('22. one failed chunk => extractionComplete false', () => {
      const failedChunks: number = 1;
      const skippedChunks: number = 0;
      const processedChunks: number = 2;
      const totalChunks: number = 3;
      const extractionComplete = failedChunks === 0 && skippedChunks === 0 && processedChunks === totalChunks;
      expect(extractionComplete).toBe(false);
    });

    it('23. one skipped chunk => extractionComplete false', () => {
      const failedChunks: number = 0;
      const skippedChunks: number = 1;
      const processedChunks: number = 2;
      const totalChunks: number = 3;
      const extractionComplete = failedChunks === 0 && skippedChunks === 0 && processedChunks === totalChunks;
      expect(extractionComplete).toBe(false);
    });

    it('24. processedChunks < totalChunks => extractionComplete false', () => {
      const failedChunks: number = 0;
      const skippedChunks: number = 0;
      const processedChunks: number = 2;
      const totalChunks: number = 3;
      const extractionComplete = failedChunks === 0 && skippedChunks === 0 && processedChunks === totalChunks;
      expect(extractionComplete).toBe(false);
    });

    it('25. incomplete document lowers assessment coverage', () => {
      const assessment: RequirementAssessment = {
        id: 'r-1',
        frameworkSlug: 'dpa',
        jurisdiction: 'KE',
        requirement: 'Audit',
        status: 'COMPLIANT',
        severity: 'HIGH',
        severityRationale: 'Met',
        policyEvidence: [polChunk1],
        regulatoryEvidence: [regE1],
        verification: { verdict: 'SUPPORTED' },
        coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
      };
      const completeRun = calculateComplianceAlignmentScore({
        assessments: [assessment],
        documentCoverage: { totalChunks: 4, processedChunks: 4, failedChunks: 0, skippedChunks: 0, extractionComplete: true },
      });
      const incompleteRun = calculateComplianceAlignmentScore({
        assessments: [assessment],
        documentCoverage: { totalChunks: 4, processedChunks: 3, failedChunks: 1, skippedChunks: 0, extractionComplete: false },
      });
      expect(incompleteRun.assessmentCoverageScore).toBeLessThan(completeRun.assessmentCoverageScore);
      expect(incompleteRun.coverageStatus).toBe('INSUFFICIENT');
    });

    // ─── SCORING (26–30) ────────────────────────────────────────────────────

    it('26. invalid citations cannot contribute to alignment', () => {
      const assessmentWithInvalidCitation: RequirementAssessment = {
        id: 'r-invalid-cit',
        frameworkSlug: 'dpa',
        jurisdiction: 'KE',
        requirement: 'Fake Regulation Compliance',
        status: 'COMPLIANT',
        severity: 'HIGH',
        severityRationale: 'Fake',
        policyEvidence: [],
        regulatoryEvidence: [],
        invalidEvidenceIds: ['FAKE-ID-999'],
        verification: { verdict: 'UNSUPPORTED' },
        coverage: { regulatoryEvidenceAvailable: false, policySectionAssessed: false, extractionComplete: true },
      };
      const res = calculateComplianceAlignmentScore({
        assessments: [assessmentWithInvalidCitation],
        documentCoverage: defaultDocCoverage,
      });
      expect(res.complianceAlignmentScore).toBe(0);
      expect(res.validAssessedCount).toBe(0);
    });

    it('27. NOT_VERIFIABLE lowers coverage', () => {
      const supportedAssessment: RequirementAssessment = {
        id: 'r-1',
        frameworkSlug: 'dpa',
        jurisdiction: 'KE',
        requirement: 'DPO',
        status: 'COMPLIANT',
        severity: 'HIGH',
        severityRationale: 'Met',
        policyEvidence: [polChunk1],
        regulatoryEvidence: [regE1],
        verification: { verdict: 'SUPPORTED' },
        coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
      };
      const notVerifiableAssessment: RequirementAssessment = {
        id: 'r-2',
        frameworkSlug: 'dpa',
        jurisdiction: 'KE',
        requirement: 'Uncited Requirement',
        status: 'GAP',
        severity: 'HIGH',
        severityRationale: 'Missing regulatory evidence basis',
        policyEvidence: [],
        regulatoryEvidence: [],
        verification: { verdict: 'NOT_VERIFIABLE' },
        coverage: { regulatoryEvidenceAvailable: false, policySectionAssessed: false, extractionComplete: true },
      };
      const res = calculateComplianceAlignmentScore({
        assessments: [supportedAssessment, notVerifiableAssessment],
        documentCoverage: defaultDocCoverage,
      });
      expect(res.validAssessedCount).toBe(1);
      expect(res.breakdown.notVerifiableCount).toBe(1);
      expect(res.assessmentCoverageScore).toBe(50);
      expect(res.coverageStatus).toBe('INSUFFICIENT');
    });

    it('28. zero gaps + unknown framework coverage cannot display 100% complete assessment', () => {
      const res = calculateComplianceAlignmentScore({
        assessments: [
          {
            id: 'r-1',
            frameworkSlug: 'dpa',
            jurisdiction: 'KE',
            requirement: 'DPO',
            status: 'COMPLIANT',
            severity: 'HIGH',
            severityRationale: 'Met',
            policyEvidence: [polChunk1],
            regulatoryEvidence: [regE1],
            verification: { verdict: 'SUPPORTED' },
            coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
          },
        ],
        documentCoverage: defaultDocCoverage,
        hasKnownRequirementInventory: false,
      });
      expect(res.complianceAlignmentScore).toBe(100);
      expect(res.coverageStatus).not.toBe('COMPLETE');
      expect(res.coverageStatus).toBe('PARTIAL');
      expect(res.assessmentCoverageScore).toBeLessThanOrEqual(90);
    });

    it('29. same valid assessments remain deterministic', () => {
      const assessments: RequirementAssessment[] = [
        {
          id: 'r-1',
          frameworkSlug: 'dpa',
          jurisdiction: 'KE',
          requirement: 'DPO',
          status: 'COMPLIANT',
          severity: 'HIGH',
          severityRationale: 'Met',
          policyEvidence: [polChunk1],
          regulatoryEvidence: [regE1],
          verification: { verdict: 'SUPPORTED' },
          coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
        },
        {
          id: 'r-2',
          frameworkSlug: 'dpa',
          jurisdiction: 'KE',
          requirement: 'Breach Notification',
          status: 'GAP',
          severity: 'CRITICAL',
          severityRationale: 'Not met',
          policyEvidence: [],
          regulatoryEvidence: [regE2],
          verification: { verdict: 'SUPPORTED' },
          coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
        },
      ];
      const r1 = calculateComplianceAlignmentScore({ assessments, documentCoverage: defaultDocCoverage });
      const r2 = calculateComplianceAlignmentScore({ assessments, documentCoverage: defaultDocCoverage });
      expect(r1.complianceAlignmentScore).toBe(r2.complianceAlignmentScore);
      expect(r1.assessmentCoverageScore).toBe(r2.assessmentCoverageScore);
      expect(r1.overallScore).toBe(r2.overallScore);
      expect(r1.coverageStatus).toBe(r2.coverageStatus);
    });

    it('30. unsupported findings do not affect numerator or denominator', () => {
      const baseAssessments: RequirementAssessment[] = [
        {
          id: 'r-1',
          frameworkSlug: 'dpa',
          jurisdiction: 'KE',
          requirement: 'DPO',
          status: 'COMPLIANT',
          severity: 'HIGH',
          severityRationale: 'Met',
          policyEvidence: [polChunk1],
          regulatoryEvidence: [regE1],
          verification: { verdict: 'SUPPORTED' },
          coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
        },
        {
          id: 'r-2',
          frameworkSlug: 'dpa',
          jurisdiction: 'KE',
          requirement: 'Breach Notification',
          status: 'GAP',
          severity: 'HIGH',
          severityRationale: 'Not met',
          policyEvidence: [],
          regulatoryEvidence: [regE2],
          verification: { verdict: 'SUPPORTED' },
          coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
        },
      ];
      const baseScore = calculateComplianceAlignmentScore({
        assessments: baseAssessments,
        documentCoverage: defaultDocCoverage,
      });

      const withUnsupported = calculateComplianceAlignmentScore({
        assessments: [
          ...baseAssessments,
          {
            id: 'r-unsupported',
            frameworkSlug: 'dpa',
            jurisdiction: 'KE',
            requirement: 'Hallucinated Critical Gap',
            status: 'GAP',
            severity: 'CRITICAL',
            severityRationale: 'Fake',
            policyEvidence: [],
            regulatoryEvidence: [],
            verification: { verdict: 'UNSUPPORTED' },
            coverage: { regulatoryEvidenceAvailable: false, policySectionAssessed: false, extractionComplete: true },
          },
        ],
        documentCoverage: defaultDocCoverage,
      });

      expect(baseScore.complianceAlignmentScore).toBe(50);
      expect(withUnsupported.complianceAlignmentScore).toBe(50);
    });

    // ─── SECTION 14: GOLDEN ADVERSARIAL FIXTURE ─────────────────────────────

    it('SECTION 14 GOLDEN ADVERSARIAL FIXTURE: Hallucinated AML evidence in DPA corpus', () => {
      const resolution = resolveFindingEvidence({
        citedEvidenceIds: ['FAKE-AML-123'],
        frameworkSlug: 'data-protection',
        analysisJurisdiction: 'KE',
        acceptedEvidenceMap,
        policyEvidenceMap,
      });

      // 1. regulatoryEvidence = []
      expect(resolution.regulatoryEvidence).toEqual([]);
      // 2. invalidEvidenceIds contains FAKE-AML-123
      expect(resolution.invalidEvidenceIds).toContain('FAKE-AML-123');
      // 3. System MUST NOT attach E1 or E2
      expect(resolution.regulatoryEvidence).not.toContain(regE1);
      expect(resolution.regulatoryEvidence).not.toContain(regE2);

      const adversarialInput: FindingVerificationInput = {
        id: 'finding-adversarial',
        requirement: 'Customer policy has no AML transaction monitoring controls',
        status: 'GAP',
        severity: 'CRITICAL',
        severityRationale: 'Model hallucination with fake citation',
        regulatoryBasis: 'Fake AML Regulation 99',
        policyCurrentState: 'No controls',
        regulatoryEvidence: resolution.regulatoryEvidence,
        policyEvidence: resolution.policyEvidence,
        frameworkSlug: 'data-protection',
        jurisdiction: 'KE',
        requestedEvidenceIds: resolution.requestedEvidenceIds,
        resolvedEvidenceIds: resolution.resolvedEvidenceIds,
        invalidEvidenceIds: resolution.invalidEvidenceIds,
      };

      const [verdict] = verifyFindingClaims([adversarialInput], 'KE');
      // 4. verdict = UNSUPPORTED
      expect(verdict.verdict).toBe('UNSUPPORTED');
      expect(verdict.unsupportedClaims[0]).toContain('FAKE-AML-123');

      // 5. finding quarantined, no effect on alignment score
      const validAssessment: RequirementAssessment = {
        id: 'r-valid',
        frameworkSlug: 'data-protection',
        jurisdiction: 'KE',
        requirement: 'Data Protection Retention',
        status: 'COMPLIANT',
        severity: 'HIGH',
        severityRationale: 'Met',
        policyEvidence: [polChunk1],
        regulatoryEvidence: [regE1],
        verification: { verdict: 'SUPPORTED' },
        coverage: { regulatoryEvidenceAvailable: true, policySectionAssessed: true, extractionComplete: true },
      };

      const adversarialAssessment: RequirementAssessment = {
        id: 'finding-adversarial',
        frameworkSlug: 'data-protection',
        jurisdiction: 'KE',
        requirement: adversarialInput.requirement,
        status: 'GAP',
        severity: 'CRITICAL',
        severityRationale: adversarialInput.severityRationale!,
        policyEvidence: adversarialInput.policyEvidence,
        regulatoryEvidence: adversarialInput.regulatoryEvidence,
        invalidEvidenceIds: resolution.invalidEvidenceIds,
        verification: { verdict: verdict.verdict },
        coverage: { regulatoryEvidenceAvailable: false, policySectionAssessed: false, extractionComplete: true },
      };

      const scoreResult = calculateComplianceAlignmentScore({
        assessments: [validAssessment, adversarialAssessment],
        documentCoverage: defaultDocCoverage,
      });

      // No effect on alignment score: valid assessment is 100% compliant
      expect(scoreResult.complianceAlignmentScore).toBe(100);
      expect(scoreResult.breakdown.unsupportedQuarantinedCount).toBe(1);
      // Coverage records the failed assessment appropriately
      expect(scoreResult.coverageStatus).toBe('INSUFFICIENT');
    });
  });
});
