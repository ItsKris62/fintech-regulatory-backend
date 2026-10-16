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

import {
  buildCorpusSourceSetFingerprint,
  CORPUS_VERSION_FALLBACK,
  getCorpusVersionSnapshot,
  type CorpusSourceIdentityRow,
} from './corpus-version';

const context = {
  mode: 'SINGLE' as const,
  jurisdictions: ['KE'] as const,
  primaryJurisdiction: 'KE' as const,
  jurisdictionSource: 'REQUEST' as const,
};

const source = {
  jurisdictionCode: 'KE',
  frameworkSlug: 'aml',
  checksum: 'checksum-a',
  documentVersion: '2026',
  indexVersion: 'v1',
  documentAuthorityStatus: 'IN_FORCE',
  documentIsBinding: true,
  documentEffectiveDate: new Date('2026-01-01T00:00:00.000Z'),
  documentEffectiveEndDate: null,
  documentOfficialUrl: 'https://authority.example/regulation/',
  approvedSourceJurisdiction: 'Kenya',
  approvedSourceAuthorityName: 'Example Authority',
  approvedSourceAuthorityType: 'REGULATOR',
  approvedSourceBaseUrl: 'https://authority.example/',
  approvedSourceStatus: 'ACTIVE',
  sourceVersionOfficialUrl: 'https://authority.example/regulation',
  sourceVersionLabel: '2026',
  sourceVersionChecksum: 'checksum-a',
  sourceVersionAuthorityStatus: 'IN_FORCE',
  sourceVersionIsBinding: true,
  sourceVersionStatus: 'ACTIVE',
  sourceVersionPublicationDate: new Date('2026-01-01T00:00:00.000Z'),
  sourceVersionEffectiveDate: new Date('2026-02-01T00:00:00.000Z'),
  sourceVersionEffectiveEndDate: null,
  chunkIndex: 7,
  chunkContentHash: 'chunk-hash-a',
  chunkIndexVersion: 'v2',
  chunkPageStart: 3,
  chunkPageEnd: 3,
  chunkSectionNumber: '12',
  chunkClauseNumber: null,
  chunkScheduleNumber: null,
  chunkHeadingPath: ['Part II', 'Section 12'],
  chunkCharStart: 1200,
  chunkCharEnd: 1600,
} satisfies CorpusSourceIdentityRow;

describe('corpus version snapshot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is stable when the active source set order changes', async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ jurisdictionCode: 'KE', version: 4 }])
      .mockResolvedValueOnce([{ ...source, checksum: 'checksum-b' }, source]);
    const first = await getCorpusVersionSnapshot(context);

    mocks.queryRaw
      .mockResolvedValueOnce([{ jurisdictionCode: 'KE', version: 4 }])
      .mockResolvedValueOnce([source, { ...source, checksum: 'checksum-b' }]);
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

  it('uses stable source fields rather than database identifiers or insertion order', () => {
    const first = buildCorpusSourceSetFingerprint([
      source,
      { ...source, frameworkSlug: 'payments', checksum: 'checksum-b' },
    ]);
    const second = buildCorpusSourceSetFingerprint([
      { ...source, frameworkSlug: 'payments', checksum: 'checksum-b' },
      source,
    ]);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['framework membership', { frameworkSlug: 'payments' }],
    ['document content', { checksum: 'checksum-b' }],
    ['document source status', { documentAuthorityStatus: 'SUPERSEDED' }],
    ['approved source status', { approvedSourceStatus: 'SUSPENDED' }],
    ['source version content', { sourceVersionChecksum: 'checksum-b' }],
    ['source version status', { sourceVersionStatus: 'SUPERSEDED' }],
    ['chunk membership', { chunkIndex: 8 }],
    ['chunk content', { chunkContentHash: 'chunk-hash-b' }],
    ['chunk source location', { chunkSectionNumber: '13' }],
  ])('changes when %s changes', (_name, patch) => {
    expect(buildCorpusSourceSetFingerprint([source])).not.toBe(
      buildCorpusSourceSetFingerprint([{ ...source, ...patch }]),
    );
  });

  it('preserves legitimate repeated content at distinct stable locations', () => {
    const repeated = { ...source, chunkContentHash: 'same-content' };
    const first = buildCorpusSourceSetFingerprint([
      repeated,
      { ...repeated, chunkIndex: 8, chunkSectionNumber: '13' },
    ]);
    const collapsed = buildCorpusSourceSetFingerprint([repeated]);

    expect(first).not.toBe(collapsed);
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
