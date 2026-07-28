import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BlogSourceQuality, BlogSuggestionPriority } from '@prisma/client';

const { findMany, update, disconnect } = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    blogArticleSuggestion: { findMany, update },
    $disconnect: disconnect,
  },
}));

vi.mock('@/utils/schema-verifier', () => ({
  validateEnvironmentSafety: vi.fn().mockReturnValue({ safe: true, environmentName: 'test', redactedUrl: '[REDACTED]' }),
}));

import { runEditorialHumanReviewBackfill } from './backfill-editorial-human-review';

function suggestionRow(overrides: Partial<{
  id: string;
  category: string;
  requiresOfficialSource: boolean;
  sourceQuality: BlogSourceQuality;
  priority: BlogSuggestionPriority;
  jurisdiction: string;
  requiresHumanReview: boolean;
}> = {}) {
  return {
    id: 'sug_1',
    category: 'Compliance Guides',
    requiresOfficialSource: false,
    sourceQuality: BlogSourceQuality.OFFICIAL,
    priority: BlogSuggestionPriority.LOW,
    jurisdiction: 'KE',
    requiresHumanReview: true, // stale Prisma-default value, differs from computed false
    ...overrides,
  };
}

describe('backfill-editorial-human-review', () => {
  const originalArgv = process.argv;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { validateEnvironmentSafety } = await import('@/utils/schema-verifier');
    vi.mocked(validateEnvironmentSafety).mockReturnValue({ safe: true, environmentName: 'test', redactedUrl: '[REDACTED]' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('dry-run (default) makes no writes even when computed values differ', async () => {
    process.argv = ['node', 'script'];
    findMany.mockResolvedValueOnce([suggestionRow()]);

    await runEditorialHumanReviewBackfill();

    expect(update).not.toHaveBeenCalled();
  });

  it('dry-run reports current/computed true and false counts and rows that would change', async () => {
    process.argv = ['node', 'script', '--dry-run'];
    findMany.mockResolvedValueOnce([
      suggestionRow({ id: 'sug_1', requiresHumanReview: true }), // computed false -> true->false change
      suggestionRow({ id: 'sug_2', requiresHumanReview: false, category: 'Regulatory Updates', requiresOfficialSource: true }), // computed true -> false->true change
    ]);

    const logSpy = vi.spyOn(console, 'log');
    await runEditorialHumanReviewBackfill();

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Total suggestions evaluated        : 2');
    expect(output).toContain('Rows changing true -> false        : 1');
    expect(output).toContain('Rows changing false -> true        : 1');
    expect(update).not.toHaveBeenCalled();
  });

  it('write mode only updates rows whose computed result differs from what is stored', async () => {
    process.argv = ['node', 'script', '--write'];
    findMany.mockResolvedValueOnce([
      suggestionRow({ id: 'sug_unchanged', requiresHumanReview: false }), // computed false, matches - no update
      suggestionRow({ id: 'sug_changed', requiresHumanReview: true }), // computed false, differs - update
    ]);
    update.mockResolvedValue({});

    await runEditorialHumanReviewBackfill();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ where: { id: 'sug_changed' }, data: { requiresHumanReview: false } });
  });

  it('reports failures without silently skipping them', async () => {
    process.argv = ['node', 'script', '--write'];
    findMany.mockResolvedValueOnce([suggestionRow({ id: 'sug_fail', requiresHumanReview: true })]);
    update.mockRejectedValueOnce(new Error('db write failed'));

    const logSpy = vi.spyOn(console, 'log');
    await runEditorialHumanReviewBackfill();

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('[failed] sug_fail: db write failed');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('groups reasons by count across all evaluated rows', async () => {
    process.argv = ['node', 'script', '--dry-run'];
    findMany.mockResolvedValueOnce([
      suggestionRow({ id: 'sug_1', category: 'Regulatory Updates', requiresOfficialSource: true }),
      suggestionRow({ id: 'sug_2', category: 'Regulatory Updates', requiresOfficialSource: true }),
    ]);

    const logSpy = vi.spyOn(console, 'log');
    await runEditorialHumanReviewBackfill();

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('MISSING_REQUIRED_OFFICIAL_SOURCE: 2');
  });

  it('paginates across multiple batches (a full-size batch triggers a second fetch)', async () => {
    process.argv = ['node', 'script', '--dry-run'];
    const BATCH_SIZE = 200;
    const fullBatch = Array.from({ length: BATCH_SIZE }, (_, i) => suggestionRow({ id: `sug_${i}` }));
    findMany.mockResolvedValueOnce(fullBatch).mockResolvedValueOnce([]);

    await runEditorialHumanReviewBackfill();

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: { id: `sug_${BATCH_SIZE - 1}` }, skip: 1 }),
    );
  });
});
