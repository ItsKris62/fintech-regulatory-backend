import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  purgeGapAnalysisRetention,
  type GapAnalysisRetentionDependencies,
} from './purge-gap-analysis-retention';

const now = new Date('2026-10-16T12:00:00.000Z');

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gap-1',
    userId: 'user-1',
    organizationId: 'org-1',
    documentUrl: 'gap-analysis/org-1/gap-1/source.pdf',
    reportUrl: 'gap-analysis-exports/org-1/gap-1/report.pdf',
    completedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    results: { findings: [] },
    citations: [],
    evidenceProvenance: [],
    ...overrides,
  } as any;
}

function dependencies(rows = [candidate()]): GapAnalysisRetentionDependencies {
  return {
    findCandidates: vi.fn().mockResolvedValue(rows),
    hasActiveJob: vi.fn().mockResolvedValue(false),
    deleteObject: vi.fn().mockResolvedValue(undefined),
    scrubJobPayload: vi.fn().mockResolvedValue(undefined),
    updateAnalysis: vi.fn().mockResolvedValue(undefined),
    invalidateCaches: vi.fn().mockResolvedValue(undefined),
    postverify: vi.fn().mockResolvedValue({
      documentUrl: '', reportUrl: null, results: null, executionIdentity: null,
    }),
  };
}

const options = {
  organizationId: 'org-1',
  sourceRetentionDays: 30,
  resultRetentionDays: 180,
  now,
};

describe('purgeGapAnalysisRetention', () => {
  it('is tenant-scoped, bounded, and dry-run by default', async () => {
    const deps = dependencies();
    const result = await purgeGapAnalysisRetention(options, deps);

    expect(deps.findCandidates).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1', take: 100,
    }));
    expect(deps.deleteObject).not.toHaveBeenCalled();
    expect(deps.updateAnalysis).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: 'DRY_RUN', eligible: 1, failed: 0 });
  });

  it('skips candidates with an active job', async () => {
    const deps = dependencies();
    vi.mocked(deps.hasActiveJob).mockResolvedValue(true);
    const result = await purgeGapAnalysisRetention({ ...options, write: true }, deps);

    expect(result.skippedActiveJobs).toBe(1);
    expect(deps.deleteObject).not.toHaveBeenCalled();
  });

  it('purges owned objects and customer result fields before post-verifying', async () => {
    const deps = dependencies();
    const result = await purgeGapAnalysisRetention({ ...options, write: true }, deps);

    expect(deps.deleteObject).toHaveBeenCalledTimes(2);
    expect(deps.scrubJobPayload).toHaveBeenCalledWith('gap-1');
    expect(deps.updateAnalysis).toHaveBeenCalledWith('gap-1', expect.objectContaining({
      documentUrl: '',
      documentChecksum: null,
      results: Prisma.DbNull,
      reportUrl: null,
      executionIdentity: null,
    }));
    expect(deps.invalidateCaches).toHaveBeenCalledWith('org-1', 'user-1', 'gap-1');
    expect(result).toMatchObject({
      sourceObjectsPurged: 1,
      reportObjectsPurged: 1,
      resultPayloadsPurged: 1,
      failed: 0,
    });
  });

  it('scrubs explicit-deletion tombstones without hard-deleting audit identity', async () => {
    const deps = dependencies([candidate({ deletedAt: new Date('2026-10-16T11:00:00.000Z') })]);
    const result = await purgeGapAnalysisRetention({ ...options, write: true }, deps);

    expect(deps.updateAnalysis).toHaveBeenCalledWith('gap-1', expect.objectContaining({
      documentName: '[deleted:gap-1]',
      focusAreas: Prisma.DbNull,
    }));
    expect(result.explicitDeletionTombstonesPurged).toBe(1);
  });

  it('does not clear DB references when an object is outside an owned prefix', async () => {
    const deps = dependencies([candidate({ documentUrl: 'documents/other/source.pdf' })]);
    const result = await purgeGapAnalysisRetention({ ...options, write: true }, deps);

    expect(result.failed).toBe(1);
    expect(deps.updateAnalysis).not.toHaveBeenCalled();
  });

  it('requires explicit positive policy values and enforces the batch bound', async () => {
    const deps = dependencies([]);
    await expect(purgeGapAnalysisRetention({ ...options, sourceRetentionDays: 0 }, deps))
      .rejects.toThrow('GAP_ANALYSIS_SOURCE_RETENTION_DAYS');
    await expect(purgeGapAnalysisRetention({ ...options, batchSize: 501 }, deps))
      .rejects.toThrow('must not exceed 500');
  });
});
