import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: { $queryRaw: mocks.queryRaw },
}));

vi.mock('@/utils/logger', () => ({
  logger: { warn: mocks.warn },
}));

import { CORPUS_VERSION_FALLBACK, getCorpusVersionSnapshot } from './corpus-version';

const context = {
  mode: 'SINGLE' as const,
  jurisdictions: ['KE' as const],
  primaryJurisdiction: 'KE' as const,
  jurisdictionSource: 'REQUEST' as const,
};

const source = {
  jurisdictionCode: 'KE',
  id: 'doc-1',
  checksum: 'checksum-a',
  version: '2026',
  sourceDocumentVersionId: 'source-version-1',
  indexVersion: 'v1',
  authorityStatus: 'IN_FORCE',
  isBinding: true,
  effectiveDate: new Date('2026-01-01T00:00:00.000Z'),
  effectiveEndDate: null,
  officialUrl: 'https://authority.example/regulation',
  frameworkSlug: 'aml',
};

describe('corpus version snapshot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is stable when the active source set order changes', async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ jurisdictionCode: 'KE', version: 4 }])
      .mockResolvedValueOnce([{ ...source, id: 'doc-2' }, source]);
    const first = await getCorpusVersionSnapshot(context);

    mocks.queryRaw
      .mockResolvedValueOnce([{ jurisdictionCode: 'KE', version: 4 }])
      .mockResolvedValueOnce([source, { ...source, id: 'doc-2' }]);
    const second = await getCorpusVersionSnapshot(context);

    expect(first).toEqual(second);
    expect(first.KE).toMatch(/^4:[a-f0-9]{64}$/);
  });

  it('changes when material source evidence changes', async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ jurisdictionCode: 'KE', version: 4 }])
      .mockResolvedValueOnce([source]);
    const first = await getCorpusVersionSnapshot(context);

    mocks.queryRaw
      .mockResolvedValueOnce([{ jurisdictionCode: 'KE', version: 4 }])
      .mockResolvedValueOnce([{ ...source, checksum: 'checksum-b' }]);
    const second = await getCorpusVersionSnapshot(context);

    expect(first.KE).not.toBe(second.KE);
  });

  it('fails closed to an explicit legacy marker when snapshot queries fail', async () => {
    mocks.queryRaw.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(getCorpusVersionSnapshot(context)).resolves.toEqual({
      KE: CORPUS_VERSION_FALLBACK,
    });
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({
      type: 'corpus_version_snapshot_fallback',
    }));
  });
});
