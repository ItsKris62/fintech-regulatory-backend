import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  gapFindUnique: vi.fn(),
  jobFindUnique: vi.fn(),
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    gapAnalysis: { findUnique: mocks.gapFindUnique },
    aiJob: { findUnique: mocks.jobFindUnique },
  },
}));

import {
  assertGapAnalysisStillActive,
  GapAnalysisCancelledError,
  monitorGapAnalysisCancellation,
} from './gap-analysis-cancellation';

describe('Batch 4.1 Gap Analysis cooperative cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gapFindUnique.mockResolvedValue({ deletedAt: null, status: 'ANALYZING' });
    mocks.jobFindUnique.mockResolvedValue({ status: 'RUNNING' });
  });

  it('permits an active analysis and running job', async () => {
    await expect(assertGapAnalysisStillActive('ga-1', 'job-1')).resolves.toBeUndefined();
  });

  it.each([
    [{ deletedAt: new Date(), status: 'ANALYZING' }, { status: 'RUNNING' }],
    [{ deletedAt: null, status: 'CANCELLED' }, { status: 'RUNNING' }],
    [{ deletedAt: null, status: 'ANALYZING' }, { status: 'CANCELLED' }],
    [null, { status: 'RUNNING' }],
  ])('raises a dedicated non-retryable error for deleted/cancelled state', async (analysis, job) => {
    mocks.gapFindUnique.mockResolvedValueOnce(analysis);
    mocks.jobFindUnique.mockResolvedValueOnce(job);

    const error = await assertGapAnalysisStillActive('ga-1', 'job-1').catch((caught) => caught);
    expect(error).toBeInstanceOf(GapAnalysisCancelledError);
    expect(error.retryable).toBe(false);
    expect(JSON.stringify(error)).not.toContain('SHERIABOT_PRIVATE_POLICY_CANARY_4A91F');
  });

  it('aborts an in-flight provider signal when cancellation becomes visible', async () => {
    vi.useFakeTimers();
    mocks.gapFindUnique.mockResolvedValue({ deletedAt: null, status: 'CANCELLED' });
    const monitor = monitorGapAnalysisCancellation('ga-1', 'job-1', 10);

    await vi.advanceTimersByTimeAsync(20);

    expect(monitor.signal.aborted).toBe(true);
    expect(monitor.signal.reason).toBeInstanceOf(GapAnalysisCancelledError);
    monitor.stop();
    vi.useRealTimers();
  });
});

