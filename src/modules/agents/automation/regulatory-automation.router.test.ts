import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RegulatoryInformationType,
  RegulatoryMateriality,
  RegulatoryStage,
} from '@prisma/client';
import { RegulatoryAutomationService } from './regulatory-automation.service';
import {
  RegulatorySnapshotService,
  RegulatoryItemService,
  RegulatoryAlertDraftService,
  RegulatoryFetchService,
} from '@/modules/regulatory-intelligence/domain';
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

describe('RegulatoryAutomationService Router Adapter', () => {
  let service: RegulatoryAutomationService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      regulatorySource: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      regulatorySourceSnapshot: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      regulatorySourceItem: {
        findUnique: vi.fn(),
        create: vi.fn(),
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
      $transaction: vi.fn((cb: any) => cb(mockPrisma)),
    };

    const snapshotService = new RegulatorySnapshotService(mockPrisma);
    service = new RegulatoryAutomationService({
      prisma: mockPrisma,
      snapshotService,
      itemService: new RegulatoryItemService(mockPrisma),
      alertDraftService: new RegulatoryAlertDraftService(mockPrisma),
      fetchService: new RegulatoryFetchService(mockPrisma, snapshotService),
    });
  });

  describe('listSources', () => {
    it('returns filtered operational fields for W-REG-01', async () => {
      mockPrisma.regulatorySource.findMany.mockResolvedValue([
        {
          id: 'src-1',
          sourceKey: 'ke-cbk-circulars',
          name: 'Central Bank of Kenya',
          jurisdictionCode: 'KE',
          regulatoryBody: 'CBK',
          authorityType: 'PRIMARY_OFFICIAL',
          sourceType: 'WEBSITE',
          baseUrl: 'https://www.centralbank.go.ke',
          fetchUrl: 'https://www.centralbank.go.ke/circulars',
          lastCheckedAt: new Date('2026-09-10T10:00:00Z'),
        },
      ]);

      const result = await service.listSources({ jurisdictions: 'KE' });

      expect(result.sources).toHaveLength(1);
      expect(result.sources[0].sourceKey).toBe('ke-cbk-circulars');
      expect(result.sources[0].jurisdictionCode).toBe('KE');
      expect(result.sources[0].lastCheckedAt).toBe('2026-09-10T10:00:00.000Z');
    });
  });

  describe('ingestSnapshot', () => {
    it('delegates to snapshotService and returns structured result', async () => {
      mockPrisma.regulatorySource.findUnique.mockResolvedValue({ id: 'src-1', sourceKey: 'ke-cbk', isActive: true });
      mockPrisma.regulatorySourceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.regulatorySourceSnapshot.create.mockImplementation((args: any) => ({
        id: 'snap-1',
        ...args.data,
      }));
      mockPrisma.regulatorySource.update.mockResolvedValue({});

      const result = await service.ingestSnapshot({
        sourceId: 'src-1',
        sourceUrl: 'https://www.centralbank.go.ke/circulars/2026-01',
        rawText: 'CBK Circular Content',
        title: 'CBK Circular',
      });

      expect(result.status).toBe('CREATED');
      expect(result.isNew).toBe(true);
      expect(result.snapshotId).toBe('snap-1');
    });
  });

  describe('createSourceItem', () => {
    it('persists normalized item and returns summary for W-REG-03', async () => {
      mockPrisma.regulatorySource.findUnique.mockResolvedValue({ id: 'src-1' });
      mockPrisma.regulatorySourceItem.findUnique.mockResolvedValue(null);
      mockPrisma.regulatorySourceItem.create.mockImplementation((args: any) => ({
        id: 'item-1',
        createdAt: new Date('2026-09-10T12:00:00Z'),
        ...args.data,
      }));

      const result = await service.createSourceItem({
        dedupeKey: 'item-dedupe-key-1',
        sourceId: 'src-1',
        jurisdictionCode: 'KE',
        regulator: 'CBK',
        title: 'New Banking Circular',
        summary: 'Summary of the new circular.',
        informationType: RegulatoryInformationType.CIRCULAR,
        regulatoryStage: RegulatoryStage.ISSUED,
        materiality: RegulatoryMateriality.HIGH,
      });

      expect(result.id).toBe('item-1');
      expect(result.dedupeKey).toBe('item-dedupe-key-1');
      expect(result.materiality).toBe('HIGH');
    });
  });

  describe('createAlertDraft', () => {
    it('creates an inactive draft alert and enforces isActive: false', async () => {
      mockPrisma.regulatoryAlert.findUnique.mockResolvedValue(null);
      mockPrisma.regulatorySourceItem.findUnique.mockResolvedValue({
        id: 'item-101',
        title: 'Capital Markets Directive 2026',
        summary: 'Detailed summary of CMA licensing rules.',
        jurisdictionCode: 'KE',
        regulator: 'CMA',
        informationType: RegulatoryInformationType.DIRECTIVE,
        materiality: RegulatoryMateriality.HIGH,
        effectiveDate: new Date('2026-11-01T00:00:00Z'),
        primarySnapshot: { sourceUrl: 'https://www.cma.or.ke/notice.pdf' },
      });
      mockPrisma.regulatoryAlert.create.mockImplementation((args: any) => ({
        id: 'alert-1',
        ...args.data,
      }));

      const result = await service.createAlertDraft(
        {
          sourceItemId: 'item-101',
          automationDraftKey: 'draft-cma-2026-01',
        },
        'sys-automation-orchestrator'
      );

      expect(result.isNew).toBe(true);
      expect(result.alertId).toBe('alert-1');
      expect(result.isActive).toBe(false); // MUST BE FALSE
      expect(result.primaryRegulatorySourceItemId).toBe('item-101');
      expect(result.automationDraftKey).toBe('draft-cma-2026-01');
    });
  });

  describe('fetchSource', () => {
    it('safely fetches regulatory source via backend and returns change semantics', async () => {
      mockPrisma.regulatorySource.findFirst.mockResolvedValue({
        id: 'src-1',
        sourceKey: 'ke-cbk-press',
        fetchUrl: 'https://www.centralbank.go.ke/press-releases',
        isActive: true,
      });
      mockPrisma.regulatorySource.findUnique.mockResolvedValue({
        id: 'src-1',
        sourceKey: 'ke-cbk-press',
        isActive: true,
      });

      mockPrisma.regulatorySourceSnapshot.findFirst.mockResolvedValue(null);
      mockPrisma.regulatorySourceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.regulatorySourceSnapshot.create.mockResolvedValue({
        id: 'snap-cbk-1',
        sourceId: 'src-1',
        canonicalUrl: 'https://www.centralbank.go.ke/press-releases',
      });

      vi.mocked(safeFetch).mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/html' }),
        url: 'https://www.centralbank.go.ke/press-releases',
        text: async () => '<html><body>CBK Announcement 2026</body></html>',
        json: async () => ({}) as any,
      });

      const result = await service.fetchSource({ sourceId: 'src-1' });

      expect(result.status).toBe('SUCCESS');
      expect(result.changeType).toBe('NEW');
      expect(result.snapshotId).toBe('snap-cbk-1');
      expect(result.isNew).toBe(true);
    });
  });
});

