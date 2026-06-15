import {
  CorpusGapDocumentType,
  CorpusGapJurisdiction,
  CorpusGapReportStatus,
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mailer } from '@/lib/email/mailer.service';
import { prisma } from '@/lib/prisma/client';
import { notificationModule } from '@/modules/notification';
import { corpusGapReportService } from './corpus-gap-report.service';

const prismaMock = vi.hoisted(() => ({
  corpusGapReport: {
    findFirst: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
}));

const mailerMock = vi.hoisted(() => ({
  sendNotificationEmail: vi.fn(),
}));

const notificationMock = vi.hoisted(() => ({
  createNotification: vi.fn(),
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: prismaMock,
}));

vi.mock('@/lib/email/mailer.service', () => ({
  mailer: mailerMock,
}));

vi.mock('@/modules/notification', () => ({
  notificationModule: notificationMock,
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const baseInput = {
  documentName: 'CBK Digital Credit Circular',
  issuingAuthority: 'CBK',
  documentType: CorpusGapDocumentType.CIRCULAR,
  jurisdiction: CorpusGapJurisdiction.KENYA,
  description: 'Needed for product launch review',
  sourceUrl: 'https://example.com/cbk-circular.pdf',
};

const createdReport = {
  id: 'clreportcreated000000000000',
  organizationId: 'org_1',
  reportedByUserId: 'user_1',
  documentName: baseInput.documentName,
  issuingAuthority: baseInput.issuingAuthority,
  documentType: baseInput.documentType,
  jurisdiction: baseInput.jurisdiction,
  description: baseInput.description,
  sourceUrl: baseInput.sourceUrl,
  status: CorpusGapReportStatus.PENDING,
  adminNotes: null,
  resolvedAt: null,
  createdAt: new Date('2026-06-15T09:00:00.000Z'),
  updatedAt: new Date('2026-06-15T09:00:00.000Z'),
  reportedByUser: {
    email: 'reporter@example.com',
    fullName: 'Amina Reporter',
  },
};

const adminExistingReport = {
  id: 'clreportadmin0000000000000',
  organizationId: 'org_1',
  reportedByUserId: 'user_1',
  documentName: baseInput.documentName,
  issuingAuthority: baseInput.issuingAuthority,
  documentType: baseInput.documentType,
  jurisdiction: baseInput.jurisdiction,
  description: baseInput.description,
  sourceUrl: baseInput.sourceUrl,
  status: CorpusGapReportStatus.PENDING,
  adminNotes: null,
  resolvedAt: null,
  createdAt: new Date('2026-06-15T09:00:00.000Z'),
  updatedAt: new Date('2026-06-15T09:00:00.000Z'),
  reportedByUser: {
    id: 'user_1',
    email: 'reporter@example.com',
    fullName: 'Amina Reporter',
  },
  organization: {
    id: 'org_1',
    name: 'Fintech One',
  },
};

describe('CorpusGapReportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      id: 'audit_1',
      userId: 'user_1',
      action: 'corpus_gap_report.submitted',
      entityType: 'CorpusGapReport',
      entityId: createdReport.id,
      metadata: {},
      ipAddress: null,
      userAgent: null,
      createdAt: new Date('2026-06-15T09:00:00.000Z'),
    });
    vi.mocked(mailer.sendNotificationEmail).mockResolvedValue(undefined);
    vi.mocked(notificationModule.createNotification).mockResolvedValue({
      id: 'notification_1',
      userId: 'user_1',
      type: 'CORPUS_GAP_REPORT_INGESTED',
      category: 'COMPLIANCE',
      title: 'Reported document added',
      message: 'The document was added.',
      link: '/settings/corpus-reports',
      read: false,
      readAt: null,
      metadata: {},
      createdAt: new Date('2026-06-15T09:00:00.000Z'),
    });
  });

  it('submitReport creates a report for an org member', async () => {
    vi.mocked(prisma.corpusGapReport.findFirst).mockResolvedValueOnce(null);
    vi.mocked(prisma.corpusGapReport.create).mockResolvedValueOnce(createdReport);

    await expect(corpusGapReportService.submitReport({
      organizationId: 'org_1',
      userId: 'user_1',
      input: baseInput,
    })).resolves.toMatchObject({
      outcome: 'CREATED',
      reportId: createdReport.id,
    });

    expect(prisma.corpusGapReport.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_1',
        reportedByUserId: 'user_1',
        documentName: baseInput.documentName,
        issuingAuthority: baseInput.issuingAuthority,
        documentType: baseInput.documentType,
        jurisdiction: baseInput.jurisdiction,
      }),
      select: expect.objectContaining({ id: true }),
    });
    expect(mailer.sendNotificationEmail).toHaveBeenCalledWith(
      'reporter@example.com',
      'SheriaBot corpus gap report received',
      expect.stringContaining(createdReport.id),
    );
  });

  it('duplicate submit returns DUPLICATE and does not create a second row', async () => {
    vi.mocked(prisma.corpusGapReport.findFirst).mockResolvedValueOnce({
      ...createdReport,
      id: 'existing_report',
    });

    await expect(corpusGapReportService.submitReport({
      organizationId: 'org_1',
      userId: 'user_1',
      input: baseInput,
    })).resolves.toEqual({
      outcome: 'DUPLICATE',
      reportId: 'existing_report',
    });

    expect(prisma.corpusGapReport.findFirst).toHaveBeenCalledWith({
      where: {
        documentName: { equals: baseInput.documentName, mode: 'insensitive' },
        jurisdiction: baseInput.jurisdiction,
        status: {
          in: [
            CorpusGapReportStatus.PENDING,
            CorpusGapReportStatus.UNDER_REVIEW,
          ],
        },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(prisma.corpusGapReport.create).not.toHaveBeenCalled();
  });

  it('listMyReports only queries reports for the current organization', async () => {
    vi.mocked(prisma.corpusGapReport.findMany).mockResolvedValueOnce([
      {
        id: 'report_org_1',
        organizationId: 'org_1',
        reportedByUserId: 'user_1',
        documentName: 'Kenya report',
        issuingAuthority: 'CBK',
        documentType: CorpusGapDocumentType.CIRCULAR,
        jurisdiction: CorpusGapJurisdiction.KENYA,
        description: null,
        sourceUrl: null,
        status: CorpusGapReportStatus.PENDING,
        adminNotes: null,
        createdAt: new Date('2026-06-15T09:00:00.000Z'),
        updatedAt: new Date('2026-06-15T09:00:00.000Z'),
        resolvedAt: null,
      },
    ]);
    vi.mocked(prisma.corpusGapReport.count).mockResolvedValueOnce(1);

    await expect(corpusGapReportService.listMyReports({
      organizationId: 'org_1',
      input: { page: 1, limit: 20 },
    })).resolves.toMatchObject({
      reports: [{ id: 'report_org_1' }],
      pagination: { total: 1 },
    });

    expect(prisma.corpusGapReport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org_1' },
      }),
    );
    expect(prisma.corpusGapReport.count).toHaveBeenCalledWith({
      where: { organizationId: 'org_1' },
    });
  });

  it('adminListReports supports filters', async () => {
    vi.mocked(prisma.corpusGapReport.findMany).mockResolvedValueOnce([adminExistingReport]);
    vi.mocked(prisma.corpusGapReport.count).mockResolvedValueOnce(1);

    await corpusGapReportService.adminListReports({
      input: {
        status: CorpusGapReportStatus.UNDER_REVIEW,
        jurisdiction: CorpusGapJurisdiction.RWANDA,
        documentType: CorpusGapDocumentType.GUIDELINE,
        page: 2,
        limit: 10,
      },
    });

    const expectedWhere = {
      status: CorpusGapReportStatus.UNDER_REVIEW,
      jurisdiction: CorpusGapJurisdiction.RWANDA,
      documentType: CorpusGapDocumentType.GUIDELINE,
    };

    expect(prisma.corpusGapReport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expectedWhere,
        skip: 10,
        take: 10,
      }),
    );
    expect(prisma.corpusGapReport.count).toHaveBeenCalledWith({ where: expectedWhere });
  });

  it.each([
    CorpusGapReportStatus.INGESTED,
    CorpusGapReportStatus.REJECTED,
  ])('adminUpdateStatus sets resolvedAt for %s', async (status) => {
    vi.mocked(prisma.corpusGapReport.findUnique).mockResolvedValueOnce(adminExistingReport);
    vi.mocked(prisma.corpusGapReport.update).mockResolvedValueOnce({
      ...adminExistingReport,
      status,
      resolvedAt: new Date('2026-06-15T10:00:00.000Z'),
    });

    await corpusGapReportService.adminUpdateStatus({
      adminUserId: 'admin_1',
      input: {
        reportId: adminExistingReport.id,
        status,
        adminNotes: 'Reviewed',
      },
    });

    const updateCall = vi.mocked(prisma.corpusGapReport.update).mock.calls[0]?.[0];
    expect(updateCall).toMatchObject({
      where: { id: adminExistingReport.id },
      data: {
        status,
        adminNotes: 'Reviewed',
      },
    });
    expect(updateCall?.data).toHaveProperty('resolvedAt');
    expect(updateCall?.data.resolvedAt).toBeInstanceOf(Date);
  });

  it('adminUpdateStatus creates notification and queues email when status becomes INGESTED', async () => {
    vi.mocked(prisma.corpusGapReport.findUnique).mockResolvedValueOnce(adminExistingReport);
    vi.mocked(prisma.corpusGapReport.update).mockResolvedValueOnce({
      ...adminExistingReport,
      status: CorpusGapReportStatus.INGESTED,
      resolvedAt: new Date('2026-06-15T10:00:00.000Z'),
    });

    await corpusGapReportService.adminUpdateStatus({
      adminUserId: 'admin_1',
      input: {
        reportId: adminExistingReport.id,
        status: CorpusGapReportStatus.INGESTED,
        adminNotes: 'Document ingested',
      },
    });

    expect(notificationModule.createNotification).toHaveBeenCalledWith({
      userId: adminExistingReport.reportedByUser.id,
      type: 'CORPUS_GAP_REPORT_INGESTED',
      category: 'COMPLIANCE',
      title: 'Reported document added',
      message: expect.stringContaining(adminExistingReport.documentName),
      link: '/settings/corpus-reports',
      metadata: {
        reportId: adminExistingReport.id,
        documentName: adminExistingReport.documentName,
        organizationId: adminExistingReport.organizationId,
      },
    });
    expect(mailer.sendNotificationEmail).toHaveBeenCalledWith(
      adminExistingReport.reportedByUser.email,
      "The document you reported has been added to SheriaBot's corpus",
      expect.stringContaining(adminExistingReport.id),
    );
  });
});
