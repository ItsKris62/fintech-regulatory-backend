import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import {
  RegulatoryAuthorityType,
  RegulatorySourceType,
  RegulatoryInformationType,
  RegulatoryStage,
  RegulatoryVerificationState,
  RegulatoryMateriality,
  RegulatoryEvidenceRole,
} from '@prisma/client';
import { RegulatorySourceService } from './regulatory-source.service';
import { RegulatorySnapshotService } from './regulatory-snapshot.service';
import { RegulatoryItemService } from './regulatory-item.service';
import { RegulatoryAlertDraftService } from './regulatory-alert-draft.service';
import { RegulatoryFetchService } from './regulatory-fetch.service';
import { computeRegulatoryItemDedupeKey } from './types';
import { safeFetch } from '@/utils/safe-fetch';

vi.mock('@/utils/safe-fetch', () => ({
  validateSafeUrl: vi.fn().mockResolvedValue(true),
  safeFetch: vi.fn(),
  SSRFValidationError: class SSRFValidationError extends Error {},
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Regulatory Domain Services', () => {
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      regulatorySource: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
      },
      regulatorySourceSnapshot: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        findMany: vi.fn(),
      },
      regulatorySourceItem: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
      },
      regulatorySourceItemEvidence: {
        create: vi.fn(),
        upsert: vi.fn(),
        updateMany: vi.fn(),
      },
      regulatoryAlert: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      $transaction: vi.fn((callback: any) => callback(mockPrisma)),
    };
  });

  describe('RegulatorySourceService', () => {
    it('creates a new regulatory source with validated URLs and default attributes', async () => {
      mockPrisma.regulatorySource.findUnique.mockResolvedValue(null);
      mockPrisma.regulatorySource.create.mockImplementation((args: any) => ({
        id: 'source-1',
        ...args.data,
      }));

      const service = new RegulatorySourceService(mockPrisma);
      const result = await service.createSource({
        sourceKey: 'ke-cbk-banking',
        name: 'Central Bank of Kenya - Banking Circulars',
        jurisdictionCode: 'KE',
        regulatoryBody: 'CBK',
        authorityType: RegulatoryAuthorityType.PRIMARY_OFFICIAL,
        sourceType: RegulatorySourceType.WEBSITE,
        baseUrl: 'https://www.centralbank.go.ke/circulars',
        fetchUrl: 'https://www.centralbank.go.ke/api/circulars',
      });

      expect(result.id).toBe('source-1');
      expect(result.sourceKey).toBe('ke-cbk-banking');
      expect(result.jurisdictionCode).toBe('KE');
      expect(mockPrisma.regulatorySource.create).toHaveBeenCalledTimes(1);
    });

    it('rejects duplicate sourceKey with CONFLICT error', async () => {
      mockPrisma.regulatorySource.findUnique.mockResolvedValue({ id: 'existing-1', sourceKey: 'ke-cbk-banking' });
      const service = new RegulatorySourceService(mockPrisma);

      await expect(
        service.createSource({
          sourceKey: 'ke-cbk-banking',
          name: 'Central Bank of Kenya',
          jurisdictionCode: 'KE',
          regulatoryBody: 'CBK',
          authorityType: RegulatoryAuthorityType.PRIMARY_OFFICIAL,
          sourceType: RegulatorySourceType.WEBSITE,
          baseUrl: 'https://www.centralbank.go.ke',
        })
      ).rejects.toThrow(TRPCError);
    });

    it('deactivates an existing source', async () => {
      mockPrisma.regulatorySource.update.mockResolvedValue({ id: 'source-1', isActive: false });
      const service = new RegulatorySourceService(mockPrisma);
      const result = await service.deactivateSource('source-1');
      expect(result.isActive).toBe(false);
      expect(mockPrisma.regulatorySource.update).toHaveBeenCalledWith({
        where: { id: 'source-1' },
        data: { isActive: false },
      });
    });
  });

  describe('RegulatorySnapshotService', () => {
    it('creates an immutable snapshot and returns CREATED when new', async () => {
      mockPrisma.regulatorySource.findUnique.mockResolvedValue({ id: 'source-1', sourceKey: 'ke-cbk', isActive: true });
      mockPrisma.regulatorySourceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.regulatorySourceSnapshot.create.mockImplementation((args: any) => ({
        id: 'snapshot-1',
        ...args.data,
      }));
      mockPrisma.regulatorySource.update.mockResolvedValue({});

      const service = new RegulatorySnapshotService(mockPrisma);
      const result = await service.ingestSnapshot({
        sourceId: 'source-1',
        sourceUrl: 'https://www.centralbank.go.ke/circulars/2026-01?utm_source=rss',
        rawText: 'Circular on digital asset prudential limits.',
        title: 'CBK Digital Asset Circular',
      });

      expect(result.status).toBe('CREATED');
      expect(result.isNew).toBe(true);
      expect(result.snapshotId).toBe('snapshot-1');
      expect(result.canonicalUrl).toBe('https://www.centralbank.go.ke/circulars/2026-01');
      expect(result.contentHash).toBeDefined();
    });

    it('returns DUPLICATE and isNew: false for identical snapshot', async () => {
      mockPrisma.regulatorySource.findUnique.mockResolvedValue({ id: 'source-1', sourceKey: 'ke-cbk', isActive: true });
      mockPrisma.regulatorySourceSnapshot.findUnique.mockResolvedValue({ id: 'existing-snapshot-1' });
      mockPrisma.regulatorySource.update.mockResolvedValue({});

      const service = new RegulatorySnapshotService(mockPrisma);
      const result = await service.ingestSnapshot({
        sourceId: 'source-1',
        sourceUrl: 'https://www.centralbank.go.ke/circulars/2026-01',
        rawText: 'Circular on digital asset prudential limits.',
      });

      expect(result.status).toBe('DUPLICATE');
      expect(result.isNew).toBe(false);
      expect(result.snapshotId).toBe('existing-snapshot-1');
      expect(mockPrisma.regulatorySourceSnapshot.create).not.toHaveBeenCalled();
    });

    it('handles concurrent race condition gracefully via P2002 conflict catch', async () => {
      mockPrisma.regulatorySource.findUnique.mockResolvedValue({ id: 'source-1', sourceKey: 'ke-cbk', isActive: true });
      // First lookup sees null
      mockPrisma.regulatorySourceSnapshot.findUnique
        .mockResolvedValueOnce(null)
        // Second lookup after P2002 finds the concurrently inserted row
        .mockResolvedValueOnce({ id: 'concurrent-snapshot-1' });

      mockPrisma.regulatorySourceSnapshot.create.mockRejectedValue({ code: 'P2002' });

      const service = new RegulatorySnapshotService(mockPrisma);
      const result = await service.ingestSnapshot({
        sourceId: 'source-1',
        sourceUrl: 'https://www.centralbank.go.ke/circulars/2026-01',
        rawText: 'Concurrent content.',
      });

      expect(result.status).toBe('DUPLICATE');
      expect(result.snapshotId).toBe('concurrent-snapshot-1');
      expect(result.isNew).toBe(false);
    });
  });

  describe('RegulatoryItemService', () => {
    it('creates a normalized item and links primary evidence in a transaction', async () => {
      mockPrisma.regulatorySource.findUnique.mockResolvedValue({ id: 'source-1' });
      mockPrisma.regulatorySourceSnapshot.findUnique.mockResolvedValue({ id: 'snapshot-1', sourceId: 'source-1' });
      mockPrisma.regulatorySourceItem.findUnique.mockResolvedValue(null);
      mockPrisma.regulatorySourceItem.create.mockImplementation((args: any) => ({
        id: 'item-1',
        ...args.data,
      }));

      const service = new RegulatoryItemService(mockPrisma);
      const result = await service.createItem({
        dedupeKey: 'ke-cbk-circ-2026-01',
        sourceId: 'source-1',
        primarySnapshotId: 'snapshot-1',
        jurisdictionCode: 'KE',
        regulator: 'CBK',
        title: 'Prudential Guidelines for Digital Assets 2026',
        summary: 'New capital reserve and reporting guidelines issued by CBK for digital lenders.',
        informationType: RegulatoryInformationType.CIRCULAR,
        regulatoryStage: RegulatoryStage.ISSUED,
        verificationState: RegulatoryVerificationState.SOURCE_VERIFIED,
        materiality: RegulatoryMateriality.HIGH,
      });

      expect(result.id).toBe('item-1');
      expect(result.dedupeKey).toBe('ke-cbk-circ-2026-01');
      expect(mockPrisma.regulatorySourceItemEvidence.create).toHaveBeenCalledWith({
        data: {
          sourceItemId: 'item-1',
          snapshotId: 'snapshot-1',
          role: RegulatoryEvidenceRole.PRIMARY,
          isPrimary: true,
        },
      });
    });

    it('rejects duplicate dedupeKey with CONFLICT', async () => {
      mockPrisma.regulatorySource.findUnique.mockResolvedValue({ id: 'source-1' });
      mockPrisma.regulatorySourceItem.findUnique.mockResolvedValue({ id: 'existing-item-1' });

      const service = new RegulatoryItemService(mockPrisma);
      await expect(
        service.createItem({
          dedupeKey: 'ke-cbk-circ-2026-01',
          sourceId: 'source-1',
          jurisdictionCode: 'KE',
          regulator: 'CBK',
          title: 'Duplicate Item',
          summary: 'Summary text here.',
        })
      ).rejects.toThrow(TRPCError);
    });

    it('links additional evidence while enforcing single primary constraint', async () => {
      mockPrisma.regulatorySourceItem.findUnique.mockResolvedValue({ id: 'item-1' });
      mockPrisma.regulatorySourceSnapshot.findUnique.mockResolvedValue({ id: 'snapshot-2' });

      const service = new RegulatoryItemService(mockPrisma);
      await service.linkEvidence({
        sourceItemId: 'item-1',
        snapshotId: 'snapshot-2',
        role: RegulatoryEvidenceRole.PRIMARY,
        isPrimary: true,
      });

      expect(mockPrisma.regulatorySourceItemEvidence.updateMany).toHaveBeenCalledWith({
        where: { sourceItemId: 'item-1', isPrimary: true },
        data: { isPrimary: false },
      });
      expect(mockPrisma.regulatorySourceItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { primarySnapshotId: 'snapshot-2' },
      });
      expect(mockPrisma.regulatorySourceItemEvidence.upsert).toHaveBeenCalled();
    });
  });

  describe('RegulatoryAlertDraftService', () => {
    it('creates an inactive draft alert with zero notifications and links primary source item', async () => {
      mockPrisma.regulatoryAlert.findUnique.mockResolvedValue(null);
      mockPrisma.regulatorySourceItem.findUnique.mockResolvedValue({
        id: 'item-1',
        title: 'CBK Circular Title',
        summary: 'Full summary text of the circular.',
        jurisdictionCode: 'KE',
        regulator: 'CBK',
        informationType: RegulatoryInformationType.CIRCULAR,
        materiality: RegulatoryMateriality.HIGH,
        effectiveDate: new Date('2026-10-01T00:00:00Z'),
        primarySnapshot: { sourceUrl: 'https://www.centralbank.go.ke/doc.pdf' },
      });
      mockPrisma.regulatoryAlert.create.mockImplementation((args: any) => ({
        id: 'alert-draft-1',
        ...args.data,
      }));

      const service = new RegulatoryAlertDraftService(mockPrisma);
      const result = await service.createAlertDraft(
        {
          sourceItemId: 'item-1',
          automationDraftKey: 'draft-key-cbk-2026-01',
        },
        'user-admin-1'
      );

      expect(result.isNew).toBe(true);
      expect(result.alert.id).toBe('alert-draft-1');
      expect(result.alert.isActive).toBe(false); // MUST be false
      expect(result.alert.primaryRegulatorySourceItemId).toBe('item-1');
      expect(result.alert.automationDraftKey).toBe('draft-key-cbk-2026-01');
      expect(result.alert.severity).toBe('HIGH');
      expect(result.alert.category).toBe('PRUDENTIAL');
    });

    it('returns existing draft idempotently on repeat automationDraftKey', async () => {
      mockPrisma.regulatoryAlert.findUnique.mockResolvedValue({
        id: 'existing-alert-draft-1',
        automationDraftKey: 'draft-key-cbk-2026-01',
        isActive: false,
      });

      const service = new RegulatoryAlertDraftService(mockPrisma);
      const result = await service.createAlertDraft(
        {
          sourceItemId: 'item-1',
          automationDraftKey: 'draft-key-cbk-2026-01',
        },
        'user-admin-1'
      );

      expect(result.isNew).toBe(false);
      expect(result.alert.id).toBe('existing-alert-draft-1');
      expect(mockPrisma.regulatoryAlert.create).not.toHaveBeenCalled();
    });
  });

  describe('RegulatoryFetchService', () => {
    let snapshotService: RegulatorySnapshotService;
    let fetchService: RegulatoryFetchService;

    beforeEach(() => {
      snapshotService = new RegulatorySnapshotService(mockPrisma);
      fetchService = new RegulatoryFetchService(mockPrisma, snapshotService);
      vi.clearAllMocks();
    });

    it('returns UNCHANGED and 304 when ETag conditional header matches', async () => {
      mockPrisma.regulatorySource.findFirst.mockResolvedValue({
        id: 'source-1',
        sourceKey: 'cbk-press',
        fetchUrl: 'https://www.centralbank.go.ke/press-releases',
        baseUrl: 'https://www.centralbank.go.ke',
        isActive: true,
      });

      mockPrisma.regulatorySourceSnapshot.findFirst.mockResolvedValue({
        id: 'snap-prev-1',
        etag: '"etag-123"',
        lastModified: 'Wed, 10 Sep 2026 12:00:00 GMT',
        contentHash: 'hash-abc',
        canonicalUrl: 'https://www.centralbank.go.ke/press-releases',
      });

      vi.mocked(safeFetch).mockResolvedValue({
        ok: true,
        status: 304,
        statusText: 'Not Modified',
        headers: new Headers({ 'content-type': 'text/html' }),
        url: 'https://www.centralbank.go.ke/press-releases',
        text: async () => '',
        json: async () => ({}) as any,
      });

      const result = await fetchService.fetchAndIngestSource({ sourceId: 'source-1' });

      expect(result.status).toBe('SUCCESS');
      expect(result.changeType).toBe('UNCHANGED');
      expect(result.httpStatus).toBe(304);
      expect(result.isNew).toBe(false);
      expect(mockPrisma.regulatorySource.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'source-1' },
          data: expect.objectContaining({ failureCount: 0 }),
        })
      );
    });

    it('returns UNCHANGED when content hash matches latest snapshot on HTTP 200', async () => {
      mockPrisma.regulatorySource.findFirst.mockResolvedValue({
        id: 'source-1',
        sourceKey: 'cbk-press',
        fetchUrl: 'https://www.centralbank.go.ke/press-releases',
        isActive: true,
      });

      const normalizedPayload = 'Central Bank of Kenya Press Release 2026';
      const expectedHash = snapshotService.normalizeAndHash(normalizedPayload).contentHash;

      mockPrisma.regulatorySourceSnapshot.findFirst.mockResolvedValue({
        id: 'snap-prev-1',
        contentHash: expectedHash,
        canonicalUrl: 'https://www.centralbank.go.ke/press-releases',
      });

      vi.mocked(safeFetch).mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/html', etag: '"etag-new"' }),
        url: 'https://www.centralbank.go.ke/press-releases',
        text: async () => `<html><body>${normalizedPayload}</body></html>`,
        json: async () => ({}) as any,
      });

      const result = await fetchService.fetchAndIngestSource({ sourceId: 'source-1' });

      expect(result.status).toBe('SUCCESS');
      expect(result.changeType).toBe('UNCHANGED');
      expect(result.contentHash).toBe(expectedHash);
      expect(result.isNew).toBe(false);
      expect(mockPrisma.regulatorySourceSnapshot.create).not.toHaveBeenCalled();
    });

    it('creates NEW snapshot when no previous snapshot exists', async () => {
      mockPrisma.regulatorySource.findFirst.mockResolvedValue({
        id: 'source-1',
        sourceKey: 'cbk-press',
        fetchUrl: 'https://www.centralbank.go.ke/press-releases',
        isActive: true,
      });
      mockPrisma.regulatorySource.findUnique.mockResolvedValue({
        id: 'source-1',
        sourceKey: 'cbk-press',
        isActive: true,
      });

      mockPrisma.regulatorySourceSnapshot.findFirst.mockResolvedValue(null);
      mockPrisma.regulatorySourceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.regulatorySourceSnapshot.create.mockResolvedValue({
        id: 'new-snap-1',
        sourceId: 'source-1',
        canonicalUrl: 'https://www.centralbank.go.ke/press-releases',
      });

      vi.mocked(safeFetch).mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/html' }),
        url: 'https://www.centralbank.go.ke/press-releases',
        text: async () => '<html><body>First ever regulatory release content</body></html>',
        json: async () => ({}) as any,
      });

      const result = await fetchService.fetchAndIngestSource({ sourceId: 'source-1' });

      expect(result.status).toBe('SUCCESS');
      expect(result.changeType).toBe('NEW');
      expect(result.snapshotId).toBe('new-snap-1');
      expect(result.isNew).toBe(true);
      expect(mockPrisma.regulatorySourceSnapshot.create).toHaveBeenCalled();
    });

    it('records failure and increments failureCount when fetch fails', async () => {
      mockPrisma.regulatorySource.findFirst.mockResolvedValue({
        id: 'source-1',
        sourceKey: 'cbk-press',
        fetchUrl: 'https://www.centralbank.go.ke/press-releases',
        isActive: true,
      });

      vi.mocked(safeFetch).mockRejectedValue(new Error('Connection timed out'));

      const result = await fetchService.fetchAndIngestSource({ sourceId: 'source-1' });

      expect(result.status).toBe('FAILED');
      expect(result.error).toContain('Connection timed out');
      expect(result.isNew).toBe(false);
      expect(mockPrisma.regulatorySource.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'source-1' },
          data: expect.objectContaining({
            failureCount: { increment: 1 },
            lastFailureReason: 'Connection timed out',
          }),
        })
      );
    });
  });

  describe('computeRegulatoryItemDedupeKey', () => {
    it('prefers official reference number over URL and title', () => {
      const key = computeRegulatoryItemDedupeKey({
        jurisdictionCode: 'KE',
        regulator: 'CBK',
        sourceId: 'src-1',
        title: 'Prudential Guideline 2026',
        officialReference: 'CBK/PG/01/2026',
        canonicalUrl: 'https://centralbank.go.ke/docs/pg.pdf',
      });

      expect(key).toBe('ref:KE:CBK:CBK/PG/01/2026');
    });

    it('uses canonical URL when official reference is absent', () => {
      const key = computeRegulatoryItemDedupeKey({
        jurisdictionCode: 'KE',
        regulator: 'CBK',
        sourceId: 'src-1',
        title: 'Circular on Mobile Money',
        canonicalUrl: 'https://centralbank.go.ke/circulars/2026-01',
      });

      expect(key).toBe('url:KE:CBK:https://centralbank.go.ke/circulars/2026-01');
    });

    it('uses source GUID when URL and official ref are absent', () => {
      const key = computeRegulatoryItemDedupeKey({
        jurisdictionCode: 'RW',
        regulator: 'BNR',
        sourceId: 'src-rw-1',
        title: 'Directive on Capital',
        guid: 'bnr-dir-9988',
      });

      expect(key).toBe('guid:src-rw-1:bnr-dir-9988');
    });

    it('falls back to deterministic fingerprint when no stable IDs exist', () => {
      const key1 = computeRegulatoryItemDedupeKey({
        jurisdictionCode: 'MW',
        regulator: 'RBM',
        sourceId: 'src-mw-1',
        title: 'Notice on Exchange Rate',
        publicationDate: '2026-09-10T10:00:00Z',
      });

      const key2 = computeRegulatoryItemDedupeKey({
        jurisdictionCode: 'MW',
        regulator: 'RBM',
        sourceId: 'src-mw-1',
        title: 'Notice on Exchange Rate',
        publicationDate: '2026-09-10T15:00:00Z', // same date (2026-09-10)
      });

      expect(key1.startsWith('fp:v1:src-mw-1:')).toBe(true);
      expect(key1).toBe(key2);
    });
  });

  describe('Enum Vocabulary Invariants', () => {
    it('verifies exact authoritative Prisma enums exist', () => {
      expect(RegulatoryAuthorityType.PRIMARY_OFFICIAL).toBe('PRIMARY_OFFICIAL');
      expect(RegulatoryAuthorityType.AUTHORITATIVE).toBe('AUTHORITATIVE');
      expect(RegulatoryAuthorityType.SECONDARY_VERIFIED).toBe('SECONDARY_VERIFIED');

      expect(RegulatorySourceType.WEBSITE).toBe('WEBSITE');
      expect(RegulatorySourceType.FEED_RSS).toBe('FEED_RSS');
      expect(RegulatorySourceType.GAZETTE_FEED).toBe('GAZETTE_FEED');
      expect(RegulatorySourceType.API).toBe('API');
      expect(RegulatorySourceType.PORTAL).toBe('PORTAL');

      expect(RegulatoryInformationType.CIRCULAR).toBe('CIRCULAR');
      expect(RegulatoryInformationType.GUIDANCE).toBe('GUIDANCE');
      expect(RegulatoryInformationType.DIRECTIVE).toBe('DIRECTIVE');
      expect(RegulatoryInformationType.NOTICE).toBe('NOTICE');

      expect(RegulatoryStage.DRAFT).toBe('DRAFT');
      expect(RegulatoryStage.ISSUED).toBe('ISSUED');
      expect(RegulatoryStage.GAZETTED).toBe('GAZETTED');
      expect(RegulatoryStage.EFFECTIVE).toBe('EFFECTIVE');

      expect(RegulatoryVerificationState.UNVERIFIED).toBe('UNVERIFIED');
      expect(RegulatoryVerificationState.SOURCE_VERIFIED).toBe('SOURCE_VERIFIED');

      expect(RegulatoryMateriality.LOW).toBe('LOW');
      expect(RegulatoryMateriality.MEDIUM).toBe('MEDIUM');
      expect(RegulatoryMateriality.HIGH).toBe('HIGH');
      expect(RegulatoryMateriality.CRITICAL).toBe('CRITICAL');

      expect(RegulatoryEvidenceRole.PRIMARY).toBe('PRIMARY');
      expect(RegulatoryEvidenceRole.SUPPORTING).toBe('SUPPORTING');
    });
  });
});

