import type { GapAnalysisDepth } from './gap-analysis.config';

export const GAP_ANALYSIS_EXECUTION_PROFILE_VERSION = 'gap-analysis-depth-v2';

export type GapAnalysisQueryStrategy =
  | 'MATERIAL_RISK_SCREENING'
  | 'FRAMEWORK_TOPIC_DECOMPOSITION'
  | 'REQUIREMENT_ITERATIVE_DECOMPOSITION';

export interface GapAnalysisDepthProfile {
  depth: GapAnalysisDepth;
  retrieval: {
    queryStrategy: GapAnalysisQueryStrategy;
    queriesPerFramework: number;
    topK: number;
    candidateMultiplier: 2;
    minScore: number;
    rerankingEnabled: true;
    gradingEnabled: true;
    weakEvidenceRetryLimit: number;
    maxWeakEvidenceRetriesTotal: number;
    maxAcceptedEvidencePerFramework: number;
    maxRetrievalOperations: number;
    concurrency: number;
  };
  document: {
    strategy: 'BOUNDED_SECTION_SCREENING' | 'COMPLETE_CONFIGURED_TRAVERSAL' | 'ENHANCED_STRUCTURAL_TRAVERSAL';
    chunkSize: number;
    chunkOverlap: number;
    maxChunks: number;
    concurrency: 1;
  };
  analysis: {
    passes: 1 | 2;
    requirementDiscovery: 'MATERIAL_ONLY' | 'FRAMEWORK_EVIDENCE' | 'ITERATIVE_EVIDENCE';
    crossChunkSynthesis: boolean;
    contradictionReview: boolean;
    enhancedReview: boolean;
    singlePassOutputTokens: number;
    chunkOutputTokens: number;
    mergeOutputTokens: number;
    enhancedReviewOutputTokens: number;
  };
  verification: {
    mode: 'BASELINE' | 'SECONDARY_WEAK_FINDING_REVIEW' | 'SECONDARY_HIGH_RISK_REVIEW';
    secondaryReview: boolean;
    unresolvedFindingHandling: 'DISCLOSE_LIMITATION';
  };
  budget: {
    maxModelCalls: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxWallClockMs: number;
    maxEvidenceRecords: number;
  };
}

export const GAP_ANALYSIS_DEPTH_PROFILES: Readonly<Record<GapAnalysisDepth, GapAnalysisDepthProfile>> = {
  quick: {
    depth: 'quick',
    retrieval: {
      queryStrategy: 'MATERIAL_RISK_SCREENING',
      queriesPerFramework: 1,
      topK: 4,
      candidateMultiplier: 2,
      minScore: 0.65,
      rerankingEnabled: true,
      gradingEnabled: true,
      weakEvidenceRetryLimit: 0,
      maxWeakEvidenceRetriesTotal: 0,
      maxAcceptedEvidencePerFramework: 4,
      maxRetrievalOperations: 10,
      concurrency: 2,
    },
    document: {
      strategy: 'BOUNDED_SECTION_SCREENING',
      chunkSize: 8000,
      chunkOverlap: 600,
      maxChunks: 4,
      concurrency: 1,
    },
    analysis: {
      passes: 1,
      requirementDiscovery: 'MATERIAL_ONLY',
      crossChunkSynthesis: true,
      contradictionReview: false,
      enhancedReview: false,
      singlePassOutputTokens: 6000,
      chunkOutputTokens: 2500,
      mergeOutputTokens: 3000,
      enhancedReviewOutputTokens: 0,
    },
    verification: {
      mode: 'BASELINE',
      secondaryReview: false,
      unresolvedFindingHandling: 'DISCLOSE_LIMITATION',
    },
    budget: {
      maxModelCalls: 18,
      maxInputTokens: 150_000,
      maxOutputTokens: 50_000,
      maxWallClockMs: 8 * 60 * 1000,
      maxEvidenceRecords: 40,
    },
  },
  standard: {
    depth: 'standard',
    retrieval: {
      queryStrategy: 'FRAMEWORK_TOPIC_DECOMPOSITION',
      queriesPerFramework: 2,
      topK: 8,
      candidateMultiplier: 2,
      minScore: 0.6,
      rerankingEnabled: true,
      gradingEnabled: true,
      weakEvidenceRetryLimit: 1,
      maxWeakEvidenceRetriesTotal: 4,
      maxAcceptedEvidencePerFramework: 8,
      maxRetrievalOperations: 24,
      concurrency: 3,
    },
    document: {
      strategy: 'COMPLETE_CONFIGURED_TRAVERSAL',
      chunkSize: 6000,
      chunkOverlap: 800,
      maxChunks: 12,
      concurrency: 1,
    },
    analysis: {
      passes: 1,
      requirementDiscovery: 'FRAMEWORK_EVIDENCE',
      crossChunkSynthesis: true,
      contradictionReview: false,
      enhancedReview: false,
      singlePassOutputTokens: 8192,
      chunkOutputTokens: 3000,
      mergeOutputTokens: 5000,
      enhancedReviewOutputTokens: 0,
    },
    verification: {
      mode: 'SECONDARY_WEAK_FINDING_REVIEW',
      secondaryReview: true,
      unresolvedFindingHandling: 'DISCLOSE_LIMITATION',
    },
    budget: {
      maxModelCalls: 40,
      maxInputTokens: 350_000,
      maxOutputTokens: 110_000,
      maxWallClockMs: 20 * 60 * 1000,
      maxEvidenceRecords: 80,
    },
  },
  deep: {
    depth: 'deep',
    retrieval: {
      queryStrategy: 'REQUIREMENT_ITERATIVE_DECOMPOSITION',
      queriesPerFramework: 3,
      topK: 12,
      candidateMultiplier: 2,
      minScore: 0.6,
      rerankingEnabled: true,
      gradingEnabled: true,
      weakEvidenceRetryLimit: 1,
      maxWeakEvidenceRetriesTotal: 5,
      maxAcceptedEvidencePerFramework: 12,
      maxRetrievalOperations: 35,
      concurrency: 3,
    },
    document: {
      strategy: 'ENHANCED_STRUCTURAL_TRAVERSAL',
      chunkSize: 6000,
      chunkOverlap: 800,
      maxChunks: 20,
      concurrency: 1,
    },
    analysis: {
      passes: 2,
      requirementDiscovery: 'ITERATIVE_EVIDENCE',
      crossChunkSynthesis: true,
      contradictionReview: true,
      enhancedReview: true,
      singlePassOutputTokens: 8192,
      chunkOutputTokens: 3500,
      mergeOutputTokens: 8000,
      enhancedReviewOutputTokens: 4500,
    },
    verification: {
      mode: 'SECONDARY_HIGH_RISK_REVIEW',
      secondaryReview: true,
      unresolvedFindingHandling: 'DISCLOSE_LIMITATION',
    },
    budget: {
      maxModelCalls: 62,
      maxInputTokens: 650_000,
      maxOutputTokens: 190_000,
      maxWallClockMs: 35 * 60 * 1000,
      maxEvidenceRecords: 120,
    },
  },
};

export function getGapAnalysisDepthProfile(depth: GapAnalysisDepth): GapAnalysisDepthProfile {
  return GAP_ANALYSIS_DEPTH_PROFILES[depth];
}

export function buildGapAnalysisDepthDedupeScope(params: {
  organizationId: string;
  jurisdictionCode: string;
  frameworks: readonly string[];
  benchmarkDocumentIds: readonly string[];
  analysisDepth: GapAnalysisDepth;
  focusAreas: readonly string[];
}): string {
  return JSON.stringify({
    organizationId: params.organizationId,
    jurisdictionCode: params.jurisdictionCode,
    frameworks: [...params.frameworks].sort(),
    benchmarkDocumentIds: [...params.benchmarkDocumentIds].sort(),
    analysisDepth: params.analysisDepth,
    focusAreas: [...params.focusAreas].sort(),
    executionProfileVersion: GAP_ANALYSIS_EXECUTION_PROFILE_VERSION,
  });
}

export const GAP_ANALYSIS_DEPTH_ENGINE_VERSION = 'gap-analysis-depth-v2';

export function getDepthProfileVersion(depth: GapAnalysisDepth): string {
  return `${depth}-v1`;
}

export const GAP_ANALYSIS_DEPTH_PRODUCT_COPY = {
  quick: {
    label: 'Quick Scan',
    description: 'Fast screening for significant evidence-backed risks.',
    breadth: 'Limited breadth',
  },
  standard: {
    label: 'Standard Analysis',
    description: 'Balanced policy and regulatory review with broader retrieval and document traversal.',
    breadth: 'Recommended',
  },
  deep: {
    label: 'Deep Analysis',
    description: 'Expanded retrieval, cross-section review and enhanced verification.',
    breadth: 'Most thorough',
  },
} as const satisfies Readonly<Record<GapAnalysisDepth, {
  label: string;
  description: string;
  breadth: string;
}>>;
