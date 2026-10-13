import { performance } from 'node:perf_hooks';
import { GAP_ANALYSIS_DEPTHS } from '@/config/gap-analysis.config';
import { getGapAnalysisDepthProfile } from '@/config/gap-analysis-depth-profiles';
import { chunkPolicyText } from '@/lib/ai/prompts/gap-analysis';
import { buildDepthRetrievalQueries, selectPolicyChunksForDepth } from '@/modules/compliance/gap-analysis-depth-engine';

const fixtures = {
  SHORT: 3_000,
  MEDIUM: 30_000,
  LARGE: 100_000,
} as const;

function syntheticPolicy(targetCharacters: number): string {
  const section = '## Incident Management\nMaterial incidents are logged, escalated, investigated, and reviewed.\n\n';
  return section.repeat(Math.ceil(targetCharacters / section.length)).slice(0, targetCharacters);
}

const frameworkCount = 3;
const rows = Object.entries(fixtures).flatMap(([fixture, characters]) =>
  GAP_ANALYSIS_DEPTHS.map((depth) => {
    const startedAt = performance.now();
    const profile = getGapAnalysisDepthProfile(depth);
    const chunks = chunkPolicyText(
      syntheticPolicy(characters),
      profile.document.chunkSize,
      profile.document.chunkOverlap,
    );
    const traversal = selectPolicyChunksForDepth(chunks, profile);
    const queries = buildDepthRetrievalQueries({
      framework: 'Synthetic Framework',
      jurisdictionNames: 'Synthetic Jurisdiction',
      policyKeywords: ['incident', 'escalation'],
      profile,
    });
    const analysisCalls = traversal.selected.length > 1 || depth === 'deep'
      ? traversal.selected.length + 1 + (profile.analysis.enhancedReview ? 1 : 0)
      : 1;
    const verificationCalls = profile.verification.secondaryReview ? 2 : 1;
    return {
      fixture,
      depth,
      characters,
      chunksAvailable: chunks.length,
      chunksExamined: traversal.selected.length,
      regulatoryQueriesConfigured: queries.length * frameworkCount,
      maximumRetrievalCandidates: queries.length * frameworkCount * profile.retrieval.topK * profile.retrieval.candidateMultiplier,
      maximumAcceptedEvidence: Math.min(
        profile.budget.maxEvidenceRecords,
        frameworkCount * profile.retrieval.maxAcceptedEvidencePerFramework,
      ),
      applicationModelCallsConfigured: queries.length * frameworkCount + analysisCalls + verificationCalls,
      verifierCallsConfigured: verificationCalls,
      weakEvidenceRetriesConfigured: profile.retrieval.maxWeakEvidenceRetriesTotal,
      providerTokens: 'NOT VERIFIED',
      providerDuration: 'NOT VERIFIED',
      localPlanningDurationMs: Number((performance.now() - startedAt).toFixed(3)),
    };
  }),
);

console.log(JSON.stringify({
  benchmarkType: 'CONTROLLED_LOCAL_SYNTHETIC_PLANNING',
  frameworkCount,
  rows,
}, null, 2));
