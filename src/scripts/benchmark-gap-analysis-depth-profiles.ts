import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { GAP_ANALYSIS_DEPTHS } from '@/config/gap-analysis.config';
import { getGapAnalysisDepthProfile } from '@/config/gap-analysis-depth-profiles';
import { chunkPolicyText } from '@/lib/ai/prompts/gap-analysis';
import { validateGapAnalysisFile } from '@/lib/security/gap-analysis-file-validator';
import type { DocumentMalwareScanner } from '@/lib/security/gap-analysis-malware';
import { buildDepthRetrievalQueries, selectPolicyChunksForDepth } from '@/modules/compliance/gap-analysis-depth-engine';
import { DEEP_VALIDATION_SYNTHETIC_POLICIES } from './fixtures/pilot-synthetic-policies';

const sizes = { SMALL: 3_000, MEDIUM: 30_000, LARGE: 1_000_000 } as const;

const cleanScanner: DocumentMalwareScanner = {
  providerName: 'deterministic-clean-test-stub',
  status: 'DISABLED_DEVELOPMENT',
  async scan() { return { status: 'CLEAN' }; },
  async health() {
    return {
      status: 'DEGRADED', enabled: false, configured: true, reachable: true,
      provider: 'deterministic-clean-test-stub', timeoutMs: 0,
      message: 'Synthetic benchmark stub; no daemon contacted.',
    };
  },
};

function sizedPolicy(content: string, target: number): string {
  return content.repeat(Math.ceil(target / content.length)).slice(0, target);
}

async function timed<T>(operation: () => T | Promise<T>): Promise<{ value: T; durationMs: number }> {
  const startedAt = performance.now();
  const value = await operation();
  return { value, durationMs: Number((performance.now() - startedAt).toFixed(3)) };
}

async function main(): Promise<void> {
  const representativeFixtures = DEEP_VALIDATION_SYNTHETIC_POLICIES;
  const rows: Record<string, unknown>[] = [];

  for (const fixture of representativeFixtures) {
    for (const [documentSize, targetCharacters] of Object.entries(sizes)) {
      const policy = sizedPolicy(fixture.content, targetCharacters);
      const buffer = Buffer.from(policy, 'utf8');
      for (const depth of GAP_ANALYSIS_DEPTHS) {
        const totalStartedAt = performance.now();
        const memoryBefore = process.memoryUsage().heapUsed;
        const profile = getGapAnalysisDepthProfile(depth);
        const requestValidation = await timed(() => {
          if (buffer.length > 10 * 1024 * 1024) throw new Error('synthetic fixture exceeded file limit');
          return buffer.length;
        });
        const checksum = await timed(() => createHash('sha256').update(buffer).digest('hex'));
        const malware = await timed(() => cleanScanner.scan(buffer));
        const extraction = await timed(() => validateGapAnalysisFile({
          buffer, fileName: `${fixture.jurisdiction.toLowerCase()}-synthetic.txt`, fileType: 'txt', claimedMimeType: 'text/plain',
        }));
        const chunking = await timed(() => chunkPolicyText(policy, profile.document.chunkSize, profile.document.chunkOverlap));
        const traversal = selectPolicyChunksForDepth(chunking.value, profile);
        const retrievalPlanning = await timed(() => buildDepthRetrievalQueries({
          framework: fixture.frameworkSlug,
          jurisdictionNames: fixture.jurisdiction,
          policyKeywords: ['conflict', 'implementation evidence', 'unresolved obligation'],
          profile,
        }));
        const analysisCalls = traversal.selected.length > 1 || depth === 'deep'
          ? traversal.selected.length + 1 + (profile.analysis.enhancedReview ? 1 : 0)
          : 1;
        const verificationCalls = profile.verification.secondaryReview ? 2 : 1;

        rows.push({
          jurisdiction: fixture.jurisdiction,
          framework: fixture.frameworkSlug,
          fixture: fixture.name,
          fixtureType: fixture.type,
          depth,
          documentSize,
          documentBytes: buffer.length,
          chunks: traversal.selected.length,
          retrievalQueries: retrievalPlanning.value.length,
          rawRetrieved: 'NOT_VERIFIED',
          acceptedEvidence: 'NOT_VERIFIED',
          uniqueEvidence: 'NOT_VERIFIED',
          findings: 'NOT_VERIFIED',
          supportedFindings: 'NOT_VERIFIED',
          partiallySupported: 'NOT_VERIFIED',
          notVerifiable: 'NOT_VERIFIED',
          unsupported: 'NOT_VERIFIED',
          contradictions: depth === 'deep' ? 'ENABLED_NOT_EXECUTED' : 'NOT_CONFIGURED',
          unresolvedRequirements: 'NOT_VERIFIED',
          providerCalls: retrievalPlanning.value.length + analysisCalls + verificationCalls,
          inputTokens: 'NOT_VERIFIED',
          outputTokens: 'NOT_VERIFIED',
          costStatus: 'NOT_VERIFIED',
          timingsMs: {
            requestValidation: requestValidation.durationMs,
            checksum: checksum.durationMs,
            malwareScanStub: malware.durationMs,
            extraction: extraction.durationMs,
            chunking: chunking.durationMs,
            retrievalPlanning: retrievalPlanning.durationMs,
            uploadStorage: 'NOT_VERIFIED', retrieval: 'NOT_VERIFIED', rerank: 'NOT_VERIFIED',
            grading: 'NOT_VERIFIED', analysis: 'NOT_VERIFIED', verification: 'NOT_VERIFIED',
            scoring: 'NOT_VERIFIED', persistence: 'NOT_VERIFIED', reportPreparation: 'NOT_VERIFIED',
            totalLocal: Number((performance.now() - totalStartedAt).toFixed(3)),
          },
          memoryHeapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - memoryBefore),
          limits: {
            maxChunks: profile.document.maxChunks,
            maxRetrievalOperations: profile.retrieval.maxRetrievalOperations,
            maxEvidenceRecords: profile.budget.maxEvidenceRecords,
            maxModelCalls: profile.budget.maxModelCalls,
            maxInputTokens: profile.budget.maxInputTokens,
            maxOutputTokens: profile.budget.maxOutputTokens,
            maxWallClockMs: profile.budget.maxWallClockMs,
          },
        });
      }
    }
  }

  console.log(JSON.stringify({
    benchmarkType: 'DETERMINISTIC_LOCAL_SYNTHETIC_PRE_PROVIDER',
    warning: 'Local validation/planning timings are measured. R2, retrieval, provider, persistence, and end-to-end timings require a connected UAT run and remain NOT_VERIFIED.',
    rows,
  }, null, 2));
}

void main();
