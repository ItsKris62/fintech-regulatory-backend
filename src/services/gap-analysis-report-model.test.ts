import { describe, expect, it } from 'vitest';
import type { GapAnalysisResult } from '@/lib/ai/prompts/gap-analysis';
import { buildGapAnalysisReportMetrics } from './gap-analysis-report-model';

function result(overrides: Partial<GapAnalysisResult> = {}): GapAnalysisResult {
  return {
    overallScore: 81,
    assessmentCoverage: 34,
    executiveSummary: 'Summary',
    frameworks: [{ id: 'fw', name: 'Framework', score: 81, summary: '', strengths: [], gaps: [] }],
    crossCuttingStrengths: [],
    actionPlan: [],
    metadata: {
      documentName: 'Policy.pdf',
      analysisDepth: 'quick',
      frameworksAnalysed: ['Framework'],
      totalGaps: 0,
      criticalGaps: 0,
      highGaps: 0,
      analysisDate: '2026-10-09T00:00:00.000Z',
      complianceAlignmentScore: 78,
      assessmentCoverageScore: 34,
      coverageStatus: 'PARTIAL',
      inventoryCompleteness: 'PARTIAL',
      selectedBenchmarkDocuments: [],
    },
    ...overrides,
  };
}

describe('buildGapAnalysisReportMetrics', () => {
  it('keeps compliance alignment separate from partial assessment coverage', () => {
    const metrics = buildGapAnalysisReportMetrics(result());
    expect(metrics.complianceAlignment).toBe(78);
    expect(metrics.assessmentCoverage).toContain('Partial - 0 evidence-backed obligations evaluated');
    expect(metrics.assessmentCoverage).not.toContain('34%');
  });

  it('uses a percentage only for a recorded complete inventory', () => {
    const value = result();
    value.metadata.coverageStatus = 'COMPLETE';
    value.metadata.assessmentCoverageScore = 100;
    expect(buildGapAnalysisReportMetrics(value).assessmentCoverage).toBe('100% (Complete)');
  });

  it('does not manufacture a percentage when the reviewed inventory is unknown', () => {
    const value = result();
    value.metadata.coverageStatus = 'UNKNOWN';
    value.metadata.inventoryCompleteness = 'UNKNOWN';
    expect(buildGapAnalysisReportMetrics(value).assessmentCoverage).toContain('Unavailable');
  });
});
