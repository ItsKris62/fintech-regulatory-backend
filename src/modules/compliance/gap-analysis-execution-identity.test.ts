import { describe, expect, it } from 'vitest';
import {
  buildGapAnalysisExecutionIdentity,
  GAP_ANALYSIS_REUSABLE_EXECUTION_STATUSES,
} from './gap-analysis-execution-identity';

const base = {
  organizationId: 'org-a',
  documentChecksum: 'a'.repeat(64),
  jurisdictionCode: 'KE',
  frameworkSlugs: ['dpa-2019', 'cbk-guidelines'],
  benchmarkVersionIds: ['bench-2:v1', 'bench-1:v3'],
  focusAreas: ['incident response', 'retention'],
  analysisDepth: 'standard' as const,
  corpusVersions: { KE: '7' },
  pineconeIndex: 'sheriabot-legal-docs',
  pineconeNamespace: 'batch63-development-uat',
};

describe('Gap Analysis execution identity', () => {
  it('is insensitive to framework, benchmark, and focus ordering', () => {
    const left = buildGapAnalysisExecutionIdentity(base);
    const right = buildGapAnalysisExecutionIdentity({ ...base, frameworkSlugs: [...base.frameworkSlugs].reverse(), benchmarkVersionIds: [...base.benchmarkVersionIds].reverse(), focusAreas: [...base.focusAreas].reverse() });
    expect(left.key).toBe(right.key);
  });

  it('reuses the same semantic identity only for the same corpus fingerprint', () => {
    const fingerprint = `1:${'a'.repeat(64)}`;
    const sameLeft = buildGapAnalysisExecutionIdentity({ ...base, corpusVersions: { KE: fingerprint } });
    const sameRight = buildGapAnalysisExecutionIdentity({ ...base, corpusVersions: { KE: fingerprint } });
    const changed = buildGapAnalysisExecutionIdentity({
      ...base,
      corpusVersions: { KE: `1:${'b'.repeat(64)}` },
    });

    expect(sameLeft.key).toBe(sameRight.key);
    expect(sameLeft.key).not.toBe(changed.key);
  });

  it.each([
    ['tenant', { organizationId: 'org-b' }],
    ['document', { documentChecksum: 'b'.repeat(64) }],
    ['jurisdiction', { jurisdictionCode: 'RW' }],
    ['framework set', { frameworkSlugs: ['dpa-2019'] }],
    ['benchmark set', { benchmarkVersionIds: ['bench-1:v4'] }],
    ['focus areas', { focusAreas: ['retention'] }],
    ['depth', { analysisDepth: 'deep' as const }],
    ['corpus version', { corpusVersions: { KE: '8' } }],
    ['index', { pineconeIndex: 'sheriabot-legal-docs-v2' }],
    ['namespace', { pineconeNamespace: 'production' }],
  ])('changes when %s changes', (_name, patch) => {
    expect(buildGapAnalysisExecutionIdentity(base).key).not.toBe(buildGapAnalysisExecutionIdentity({ ...base, ...patch }));
  });

  it('reserves only active and completed executions', () => {
    expect(GAP_ANALYSIS_REUSABLE_EXECUTION_STATUSES).toContain('COMPLETED');
    expect(GAP_ANALYSIS_REUSABLE_EXECUTION_STATUSES).toContain('RETRYING');
    expect(GAP_ANALYSIS_REUSABLE_EXECUTION_STATUSES).not.toContain('FAILED');
    expect(GAP_ANALYSIS_REUSABLE_EXECUTION_STATUSES).not.toContain('CANCELLED');
    expect(GAP_ANALYSIS_REUSABLE_EXECUTION_STATUSES).not.toContain('DEAD_LETTERED');
  });

  it('contains no filename, raw policy text, or signed URL material', () => {
    const identity = buildGapAnalysisExecutionIdentity(base);
    const serialized = JSON.stringify(identity.canonical);

    expect(serialized).not.toContain('fileName');
    expect(serialized).not.toContain('policyText');
    expect(serialized).not.toContain('signedUrl');
  });
});
