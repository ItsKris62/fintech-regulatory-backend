import { TRPCError } from '@trpc/server';
import {
  CorpusGapDocumentType,
  CorpusGapJurisdiction,
  CorpusGapReportStatus,
  Prisma,
} from '@prisma/client';
import { mailer } from '@/lib/email/mailer.service';
import { prisma } from '@/lib/prisma/client';
import { notificationModule } from '@/modules/notification';
import { logger } from '@/utils/logger';

const ACTIVE_DUPLICATE_STATUSES = [
  CorpusGapReportStatus.PENDING,
  CorpusGapReportStatus.UNDER_REVIEW,
] as const;

const REPORT_LIST_SELECT = {
  id: true,
  documentName: true,
  jurisdiction: true,
  status: true,
  createdAt: true,
  resolvedAt: true,
} satisfies Prisma.CorpusGapReportSelect;

const ADMIN_REPORT_LIST_SELECT = {
  id: true,
  organizationId: true,
  reportedByUserId: true,
  documentName: true,
  issuingAuthority: true,
  documentType: true,
  jurisdiction: true,
  description: true,
  sourceUrl: true,
  status: true,
  adminNotes: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
  organization: { select: { id: true, name: true } },
  reportedByUser: { select: { id: true, fullName: true, email: true } },
} satisfies Prisma.CorpusGapReportSelect;

export interface SubmitCorpusGapReportInput {
  documentName: string;
  issuingAuthority: string;
  documentType: CorpusGapDocumentType;
  jurisdiction: CorpusGapJurisdiction;
  description?: string;
  sourceUrl?: string;
}

export interface ListMyCorpusGapReportsInput {
  page: number;
  limit: number;
}

export interface AdminListCorpusGapReportsInput {
  status?: CorpusGapReportStatus;
  jurisdiction?: CorpusGapJurisdiction;
  documentType?: CorpusGapDocumentType;
  page: number;
  limit: number;
}

export interface AdminUpdateCorpusGapReportStatusInput {
  reportId: string;
  status: CorpusGapReportStatus;
  adminNotes?: string;
}

export interface AdminGetCorpusGapReportInput {
  reportId: string;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function pages(total: number, limit: number): number {
  return Math.ceil(total / limit);
}

async function audit(params: {
  userId: string;
  action: string;
  entityId: string;
  organizationId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId: params.userId,
      action: params.action,
      entityType: 'CorpusGapReport',
      entityId: params.entityId,
      metadata: {
        organizationId: params.organizationId,
        ...(params.metadata ?? {}),
      },
    },
  }).catch((error: unknown) => {
    logger.warn({
      type: 'corpus_gap_report_audit_failed',
      userId: params.userId,
      reportId: params.entityId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function sendSubmitConfirmationEmail(params: {
  email: string;
  fullName: string;
  documentName: string;
  reportId: string;
}): Promise<void> {
  const message = [
    `Hi ${params.fullName},`,
    '',
    `We received your corpus gap report for "${params.documentName}".`,
    `Report ID: ${params.reportId}`,
    '',
    'The SheriaBot team will review the missing document and prioritize it for corpus expansion where appropriate.',
    '',
    'Thank you for helping improve SheriaBot.',
  ].join('\n');

  await mailer.sendNotificationEmail(
    params.email,
    'SheriaBot corpus gap report received',
    message,
  );
}

async function sendIngestedEmail(params: {
  email: string;
  fullName: string;
  documentName: string;
  reportId: string;
}): Promise<void> {
  const message = [
    `Hi ${params.fullName},`,
    '',
    `The document you reported has been added to SheriaBot's corpus: ${params.documentName}.`,
    `Report ID: ${params.reportId}`,
    '',
    'Future answers can now draw on this source where it is relevant.',
    '',
    'Thank you for helping improve SheriaBot.',
  ].join('\n');

  await mailer.sendNotificationEmail(
    params.email,
    "The document you reported has been added to SheriaBot's corpus",
    message,
  );
}

export class CorpusGapReportService {
  async submitReport(params: {
    organizationId: string;
    userId: string;
    input: SubmitCorpusGapReportInput;
  }) {
    const documentName = params.input.documentName.trim();
    const issuingAuthority = params.input.issuingAuthority.trim();
    const description = normalizeOptional(params.input.description);
    const sourceUrl = normalizeOptional(params.input.sourceUrl);

    const duplicate = await prisma.corpusGapReport.findFirst({
      where: {
        documentName: { equals: documentName, mode: 'insensitive' },
        jurisdiction: params.input.jurisdiction,
        status: { in: [...ACTIVE_DUPLICATE_STATUSES] },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    if (duplicate) {
      logger.info({
        type: 'corpus_gap_report_submitted',
        userId: params.userId,
        organizationId: params.organizationId,
        reportId: duplicate.id,
        duplicate: true,
        jurisdiction: params.input.jurisdiction,
        documentType: params.input.documentType,
      });

      return {
        outcome: 'DUPLICATE' as const,
        reportId: duplicate.id,
      };
    }

    const report = await prisma.corpusGapReport.create({
      data: {
        organizationId: params.organizationId,
        reportedByUserId: params.userId,
        documentName,
        issuingAuthority,
        documentType: params.input.documentType,
        jurisdiction: params.input.jurisdiction,
        description,
        sourceUrl,
      },
      select: {
        id: true,
        documentName: true,
        jurisdiction: true,
        status: true,
        createdAt: true,
        reportedByUser: { select: { email: true, fullName: true } },
      },
    });

    await audit({
      userId: params.userId,
      action: 'corpus_gap_report.submitted',
      entityId: report.id,
      organizationId: params.organizationId,
      metadata: {
        documentName,
        jurisdiction: params.input.jurisdiction,
        documentType: params.input.documentType,
      },
    });

    logger.info({
      type: 'corpus_gap_report_submitted',
      userId: params.userId,
      organizationId: params.organizationId,
      reportId: report.id,
      duplicate: false,
      jurisdiction: params.input.jurisdiction,
      documentType: params.input.documentType,
    });

    void sendSubmitConfirmationEmail({
      email: report.reportedByUser.email,
      fullName: report.reportedByUser.fullName,
      documentName: report.documentName,
      reportId: report.id,
    }).catch((error: unknown) => {
      logger.warn({
        type: 'corpus_gap_report_confirmation_email_failed',
        reportId: report.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return {
      outcome: 'CREATED' as const,
      reportId: report.id,
      report,
    };
  }

  async listMyReports(params: {
    organizationId: string;
    input: ListMyCorpusGapReportsInput;
  }) {
    const skip = (params.input.page - 1) * params.input.limit;
    const where: Prisma.CorpusGapReportWhereInput = {
      organizationId: params.organizationId,
    };

    const [reports, total] = await Promise.all([
      prisma.corpusGapReport.findMany({
        where,
        select: REPORT_LIST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: params.input.limit,
      }),
      prisma.corpusGapReport.count({ where }),
    ]);

    return {
      reports,
      pagination: {
        page: params.input.page,
        limit: params.input.limit,
        total,
        pages: pages(total, params.input.limit),
      },
    };
  }

  async adminListReports(params: {
    input: AdminListCorpusGapReportsInput;
  }) {
    const skip = (params.input.page - 1) * params.input.limit;
    const where: Prisma.CorpusGapReportWhereInput = {
      ...(params.input.status ? { status: params.input.status } : {}),
      ...(params.input.jurisdiction ? { jurisdiction: params.input.jurisdiction } : {}),
      ...(params.input.documentType ? { documentType: params.input.documentType } : {}),
    };

    const [reports, total] = await Promise.all([
      prisma.corpusGapReport.findMany({
        where,
        select: ADMIN_REPORT_LIST_SELECT,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip,
        take: params.input.limit,
      }),
      prisma.corpusGapReport.count({ where }),
    ]);

    return {
      reports,
      pagination: {
        page: params.input.page,
        limit: params.input.limit,
        total,
        pages: pages(total, params.input.limit),
      },
    };
  }

  async adminGetReport(params: {
    input: AdminGetCorpusGapReportInput;
  }) {
    const report = await prisma.corpusGapReport.findUnique({
      where: { id: params.input.reportId },
      include: {
        reportedByUser: { select: { id: true, email: true, fullName: true } },
        organization: { select: { id: true, name: true, type: true, plan: true } },
      },
    });

    if (!report) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Corpus gap report not found.' });
    }

    const recommendedActions: Array<{ id: string; label: string; description: string; severity: "info" | "warning" | "critical" }> = [];

    // Rule-based recommendations
    recommendedActions.push({
      id: 'verify_official_source',
      label: 'Verify Official Source',
      description: 'Check if the suggested document is an official regulatory source.',
      severity: 'info',
    });

    if (report.sourceUrl) {
      recommendedActions.push({
        id: 'review_source_url',
        label: 'Review Source URL',
        description: 'Review the provided source URL for relevance and accuracy.',
        severity: 'warning',
      });
    }

    if (report.status === CorpusGapReportStatus.PENDING) {
      recommendedActions.push({
        id: 'mark_under_review',
        label: 'Mark Under Review',
        description: 'Acknowledge the report and begin investigation.',
        severity: 'info',
      });
    }

    return {
      id: report.id,
      status: report.status,
      priority: null, // Limitation: Priority not in schema
      createdAt: report.createdAt.toISOString(),
      updatedAt: report.updatedAt.toISOString(),
      resolvedAt: report.resolvedAt?.toISOString() ?? null,

      reporter: {
        userId: report.reportedByUser.id,
        name: report.reportedByUser.fullName,
        email: report.reportedByUser.email,
      },

      organization: {
        organizationId: report.organization.id,
        name: report.organization.name,
        type: report.organization.type,
        plan: report.organization.plan,
      },

      // Limitation: Schema does not track query or run context directly for CorpusGapReport
      query: {
        queryId: null,
        question: null,
        answerPreview: null,
        status: null,
        createdAt: null,
      },

      run: {
        runId: null,
        route: null,
        grounded: null,
        verifierVerdict: null,
        fallbackReason: null,
        unsupportedClaims: null,
        acceptedChunkIds: null,
        ragSources: null,
        createdAt: null,
      },

      report: {
        suggestedDocument: report.documentName,
        notes: report.description,
        adminNotes: report.adminNotes,
        missingArea: `${report.jurisdiction} - ${report.documentType}`,
        sourceUrl: report.sourceUrl,
      },

      citations: [], // Limitation: Citations not tracked for gap reports without query/run linkage

      recommendedActions,
    };
  }

  async adminUpdateStatus(params: {
    adminUserId: string;
    input: AdminUpdateCorpusGapReportStatusInput;
  }) {
    const existing = await prisma.corpusGapReport.findUnique({
      where: { id: params.input.reportId },
      include: {
        reportedByUser: { select: { id: true, email: true, fullName: true } },
        organization: { select: { id: true, name: true } },
      },
    });

    if (!existing) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Corpus gap report not found.' });
    }

    const oldStatus = existing.status;
    const terminalResolvedStatus =
      params.input.status === CorpusGapReportStatus.INGESTED ||
      params.input.status === CorpusGapReportStatus.REJECTED;
    const shouldSetResolvedAt = terminalResolvedStatus && oldStatus !== params.input.status;

    const updated = await prisma.corpusGapReport.update({
      where: { id: existing.id },
      data: {
        status: params.input.status,
        adminNotes: normalizeOptional(params.input.adminNotes),
        ...(shouldSetResolvedAt ? { resolvedAt: new Date() } : {}),
      },
      select: ADMIN_REPORT_LIST_SELECT,
    });

    await audit({
      userId: params.adminUserId,
      action: 'corpus_gap_report.status_updated',
      entityId: existing.id,
      organizationId: existing.organizationId,
      metadata: {
        oldStatus,
        newStatus: params.input.status,
        hasAdminNotes: Boolean(normalizeOptional(params.input.adminNotes)),
      },
    });

    logger.info({
      type: 'corpus_gap_report_status_updated',
      adminUserId: params.adminUserId,
      organizationId: existing.organizationId,
      reportId: existing.id,
      oldStatus,
      newStatus: params.input.status,
    });

    if (params.input.status === CorpusGapReportStatus.INGESTED && oldStatus !== CorpusGapReportStatus.INGESTED) {
      await notificationModule.createNotification({
        userId: existing.reportedByUser.id,
        type: 'CORPUS_GAP_REPORT_INGESTED',
        category: 'COMPLIANCE',
        title: 'Reported document added',
        message: `The document you reported has been added to SheriaBot's corpus: ${existing.documentName}.`,
        link: '/settings/corpus-reports',
        metadata: {
          reportId: existing.id,
          documentName: existing.documentName,
          organizationId: existing.organizationId,
        },
      });

      void sendIngestedEmail({
        email: existing.reportedByUser.email,
        fullName: existing.reportedByUser.fullName,
        documentName: existing.documentName,
        reportId: existing.id,
      }).catch((error: unknown) => {
        logger.warn({
          type: 'corpus_gap_report_ingested_email_failed',
          reportId: existing.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return updated;
  }
}

export const corpusGapReportService = new CorpusGapReportService();
