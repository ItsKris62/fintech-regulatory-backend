import { describe, expect, it } from 'vitest';
import {
  parseGapAnalysisOutput,
  calculateDeterministicGapScore,
  GAP_SCORING_VERSION,
} from './gap-analysis';

function validResult(overrides: Record<string, unknown> = {}) {
  return {
    overallScore: 80,
    executiveSummary: 'The policy is broadly aligned but requires targeted remediation.',
    frameworks: [
      {
        id: 'DPA_2019',
        name: 'Data Protection Act 2019',
        score: 80,
        summary: 'Mostly aligned.',
        gaps: [],
        strengths: ['Defines privacy roles.'],
      },
    ],
    crossCuttingStrengths: ['Board oversight is documented.'],
    actionPlan: [],
    metadata: {
      documentName: 'policy.pdf',
      analysisDepth: 'standard',
      frameworksAnalysed: ['Data Protection Act 2019'],
      totalGaps: 0,
      criticalGaps: 0,
      highGaps: 0,
      analysisDate: '2026-06-04T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('parseGapAnalysisOutput', () => {
  it('validates JSON repaired after extraction from surrounding text', () => {
    const parsed = parseGapAnalysisOutput(`Here is the JSON:\n${JSON.stringify(validResult())}`);

    // With 0 gaps, deterministic score is 100
    expect(parsed.overallScore).toBe(100);
    expect(parsed.metadata.modelSuggestedScore).toBe(80);
    expect(parsed.metadata.selectedBenchmarkDocuments).toEqual([]);
  });

  it('rejects repaired JSON that does not satisfy the Zod schema', () => {
    const invalid = JSON.stringify(validResult({ executiveSummary: 123 })).slice(0, -1);

    expect(() => parseGapAnalysisOutput(`\n${invalid}`)).toThrow('Invalid gap analysis structure');
  });

  describe('selectedBenchmarkDocuments Zod Normalization Hardening', () => {
    it('accepts and preserves valid benchmark document objects', () => {
      const parsed = parseGapAnalysisOutput(
        JSON.stringify(
          validResult({
            metadata: {
              documentName: 'policy.pdf',
              analysisDepth: 'standard',
              frameworksAnalysed: ['Data Protection Act 2019'],
              totalGaps: 0,
              criticalGaps: 0,
              highGaps: 0,
              analysisDate: '2026-06-04T00:00:00.000Z',
              selectedBenchmarkDocuments: [
                { id: 'doc-1', title: 'National Payment Systems Act', documentType: 'Act', regulatoryBody: 'CBK' },
              ],
            },
          })
        )
      );

      expect(parsed.metadata.selectedBenchmarkDocuments).toHaveLength(1);
      expect(parsed.metadata.selectedBenchmarkDocuments[0]).toEqual({
        id: 'doc-1',
        title: 'National Payment Systems Act',
        documentType: 'Act',
        regulatoryBody: 'CBK',
      });
    });

    it('transforms array of strings into valid benchmark document objects', () => {
      const parsed = parseGapAnalysisOutput(
        JSON.stringify(
          validResult({
            metadata: {
              documentName: 'policy.pdf',
              analysisDepth: 'standard',
              frameworksAnalysed: ['Data Protection Act 2019'],
              totalGaps: 0,
              criticalGaps: 0,
              highGaps: 0,
              analysisDate: '2026-06-04T00:00:00.000Z',
              selectedBenchmarkDocuments: ['National Payment Systems Act, 2011', 'CBK Cyber Guidelines'],
            },
          })
        )
      );

      expect(parsed.metadata.selectedBenchmarkDocuments).toHaveLength(2);
      expect(parsed.metadata.selectedBenchmarkDocuments[0]).toEqual({
        id: 'National Payment Systems Act, 2011',
        title: 'National Payment Systems Act, 2011',
        documentType: null,
        regulatoryBody: null,
      });
    });

    it('defaults omitted selectedBenchmarkDocuments to empty array', () => {
      const parsed = parseGapAnalysisOutput(JSON.stringify(validResult()));
      expect(parsed.metadata.selectedBenchmarkDocuments).toEqual([]);
    });

    it('rejects malformed types (e.g. boolean array) in selectedBenchmarkDocuments', () => {
      const invalid = validResult({
        metadata: {
          documentName: 'policy.pdf',
          analysisDepth: 'standard',
          frameworksAnalysed: ['Data Protection Act 2019'],
          totalGaps: 0,
          criticalGaps: 0,
          highGaps: 0,
          analysisDate: '2026-06-04T00:00:00.000Z',
          selectedBenchmarkDocuments: [true, false],
        },
      });

      expect(() => parseGapAnalysisOutput(JSON.stringify(invalid))).toThrow('Invalid gap analysis structure');
    });
  });

  describe('dependsOn Zod Normalization Hardening in ActionPlanItem', () => {
    it('accepts array of string dependency IDs', () => {
      const parsed = parseGapAnalysisOutput(
        JSON.stringify(
          validResult({
            actionPlan: [
              {
                priority: 1,
                action: 'Draft AML policy',
                framework: 'AML/CFT',
                deadline: '30 days',
                effort: 'MEDIUM',
                resources: ['Legal'],
                dependsOn: ['action-1', 'action-2'],
              },
            ],
          })
        )
      );

      expect(parsed.actionPlan[0].dependsOn).toEqual(['action-1', 'action-2']);
    });

    it('transforms array of number dependency IDs to string array', () => {
      const parsed = parseGapAnalysisOutput(
        JSON.stringify(
          validResult({
            actionPlan: [
              {
                priority: 1,
                action: 'Draft AML policy',
                framework: 'AML/CFT',
                deadline: '30 days',
                effort: 'MEDIUM',
                resources: ['Legal'],
                dependsOn: [1, 2, 3],
              },
            ],
          })
        )
      );

      expect(parsed.actionPlan[0].dependsOn).toEqual(['1', '2', '3']);
    });

    it('defaults omitted dependsOn to empty array', () => {
      const parsed = parseGapAnalysisOutput(
        JSON.stringify(
          validResult({
            actionPlan: [
              {
                priority: 1,
                action: 'Draft AML policy',
                framework: 'AML/CFT',
                deadline: '30 days',
                effort: 'MEDIUM',
                resources: ['Legal'],
              },
            ],
          })
        )
      );

      expect(parsed.actionPlan[0].dependsOn).toEqual([]);
    });

    it('rejects invalid complex object inside dependsOn array', () => {
      const invalid = validResult({
        actionPlan: [
          {
            priority: 1,
            action: 'Draft AML policy',
            framework: 'AML/CFT',
            deadline: '30 days',
            effort: 'MEDIUM',
            resources: ['Legal'],
            dependsOn: [{ invalid: 'object' }],
          },
        ],
      });

      expect(() => parseGapAnalysisOutput(JSON.stringify(invalid))).toThrow('Invalid gap analysis structure');
    });
  });

  describe('Authoritative Deterministic Gap Scoring Service', () => {
    it('computes 100 for clean compliance with no gaps', () => {
      const result = calculateDeterministicGapScore([]);
      expect(result.calculatedScore).toBe(100);
      expect(result.penalties.totalPenalty).toBe(0);
      expect(result.scoringVersion).toBe(GAP_SCORING_VERSION);
    });

    it('computes 75 for 1 CRITICAL gap (100 - 25)', () => {
      const result = calculateDeterministicGapScore([{ severity: 'CRITICAL' }]);
      expect(result.calculatedScore).toBe(75);
      expect(result.penalties.critical).toBe(25);
    });

    it('computes 45 for 1 CRITICAL and 2 HIGH gaps (100 - 25 - 30)', () => {
      const result = calculateDeterministicGapScore([
        { severity: 'CRITICAL' },
        { severity: 'HIGH' },
        { severity: 'HIGH' },
      ]);
      expect(result.calculatedScore).toBe(45);
      expect(result.penalties.critical).toBe(25);
      expect(result.penalties.high).toBe(30);
    });

    it('computes penalties correctly for MEDIUM and LOW gaps', () => {
      const result = calculateDeterministicGapScore([
        { severity: 'MEDIUM' },
        { severity: 'LOW' },
      ]);
      expect(result.calculatedScore).toBe(89); // 100 - 8 - 3 = 89
      expect(result.penalties.medium).toBe(8);
      expect(result.penalties.low).toBe(3);
    });

    it('clamps severe gap penalties so score never falls below 0', () => {
      const severeGaps = Array.from({ length: 6 }, () => ({ severity: 'CRITICAL' as const }));
      const result = calculateDeterministicGapScore(severeGaps);
      expect(result.calculatedScore).toBe(0);
      expect(result.penalties.totalPenalty).toBe(150);
    });

    it('produces identical score regardless of gap ordering', () => {
      const orderA = calculateDeterministicGapScore([
        { severity: 'LOW' },
        { severity: 'CRITICAL' },
        { severity: 'HIGH' },
      ]);
      const orderB = calculateDeterministicGapScore([
        { severity: 'CRITICAL' },
        { severity: 'HIGH' },
        { severity: 'LOW' },
      ]);
      expect(orderA.calculatedScore).toBe(orderB.calculatedScore);
      expect(orderA.calculatedScore).toBe(57); // 100 - 25 - 15 - 3 = 57
    });

    it('overrides raw LLM overallScore with deterministic score in parseGapAnalysisOutput', () => {
      const input = validResult({
        overallScore: 95, // LLM hallucinated 95
        frameworks: [
          {
            id: 'NPSA_2011',
            name: 'National Payment Systems Act',
            score: 50,
            summary: 'Significant gaps',
            gaps: [
              {
                id: 'GAP-1',
                title: 'No PSP Authorisation',
                description: 'Operating without CBK licence',
                severity: 'CRITICAL',
                regulatoryBasis: 'National Payment Systems Act, Section 12',
                policyCurrentState: 'No license documented',
                recommendation: 'Apply for PSP license',
                effort: 'HIGH',
                priority: 1,
                evidenceRequired: ['License cert'],
              },
              {
                id: 'GAP-2',
                title: 'No CISO Appointed',
                description: 'Lack of cybersecurity governance',
                severity: 'HIGH',
                regulatoryBasis: 'CBK Cybersecurity Guidelines 2018, Section 3.1',
                policyCurrentState: 'No CISO designated',
                recommendation: 'Designate CISO',
                effort: 'MEDIUM',
                priority: 2,
                evidenceRequired: ['Appointment letter'],
              },
            ],
            strengths: [],
          },
        ],
      });

      const parsed = parseGapAnalysisOutput(JSON.stringify(input));
      // 1 CRITICAL (-25) + 1 HIGH (-15) -> Deterministic Score = 60
      expect(parsed.overallScore).toBe(60);
      expect(parsed.metadata.modelSuggestedScore).toBe(95);
      expect(parsed.metadata.calculatedScore).toBe(60);
      expect(parsed.metadata.criticalGaps).toBe(1);
      expect(parsed.metadata.highGaps).toBe(1);
      expect(parsed.metadata.totalGaps).toBe(2);
      expect(parsed.metadata.scoringVersion).toBe('v1.0-deterministic');
    });
  });
});
