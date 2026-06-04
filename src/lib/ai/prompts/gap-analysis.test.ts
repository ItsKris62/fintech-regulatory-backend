import { describe, expect, it } from 'vitest';
import { parseGapAnalysisOutput } from './gap-analysis';

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

    expect(parsed.overallScore).toBe(80);
    expect(parsed.metadata.selectedBenchmarkDocuments).toEqual([]);
  });

  it('rejects repaired JSON that does not satisfy the Zod schema', () => {
    const invalid = JSON.stringify(validResult({ overallScore: 150 })).slice(0, -1);

    expect(() => parseGapAnalysisOutput(`\n${invalid}`)).toThrow('Invalid gap analysis structure');
  });
});
