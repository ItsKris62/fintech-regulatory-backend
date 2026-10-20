import type { GapAnalysisResult } from '@/lib/ai/prompts/gap-analysis';

export interface GapAnalysisReportMetrics {
  complianceAlignment: number;
  assessmentCoverage: string;
  assessedObligations: number;
  coverageStatus: 'UNKNOWN' | 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT';
}

/**
 * Canonical report metrics consumed by export renderers. Partial coverage never
 * receives a manufactured framework denominator.
 */
export function buildGapAnalysisReportMetrics(result: GapAnalysisResult): GapAnalysisReportMetrics {
  const coverageStatus = result.metadata.coverageStatus ?? 'INSUFFICIENT';
  const score = result.metadata.assessmentCoverageScore ?? result.assessmentCoverage;
  const assessedObligations = result.frameworks.reduce(
    (total, framework) => total + framework.gaps.length,
    0,
  );

  return {
    complianceAlignment: result.metadata.complianceAlignmentScore ?? result.overallScore,
    assessedObligations,
    coverageStatus,
    assessmentCoverage: coverageStatus === 'UNKNOWN'
      ? 'Unavailable - reviewed requirement inventory scope is not established.'
      : coverageStatus === 'COMPLETE' && typeof score === 'number'
        ? `${score}% (Complete)`
        : `Partial - ${assessedObligations} evidence-backed obligations evaluated. This is not a complete framework inventory.`,
  };
}
