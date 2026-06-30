import { TRPCError } from '@trpc/server';
import {
  CorpusGapDocumentType,
  CorpusGapJurisdiction,
  CorpusGapReportStatus,
} from '@prisma/client';
import { z } from 'zod';
import { corpusGapReportService } from '@/modules/corpus-gap-report';
import { sanitizeErrorMessage } from '@/utils/error-sanitizer';
import { logger } from '@/utils/logger';
import { adminProcedure, orgMemberProcedure, router } from '../trpc/trpc';

const optionalTrimmedString = (max: number) =>
  z.string().trim().max(max).optional().transform((value) => value || undefined);

const submitReportSchema = z.object({
  documentName: z.string().trim().min(2, 'Document name is required').max(300),
  issuingAuthority: z.string().trim().min(2, 'Issuing authority is required').max(200),
  documentType: z.nativeEnum(CorpusGapDocumentType),
  jurisdiction: z.nativeEnum(CorpusGapJurisdiction),
  description: optionalTrimmedString(2000),
  sourceUrl: optionalTrimmedString(500).refine(
    (value) => !value || /^https?:\/\/\S+$/i.test(value),
    'Source URL must start with http:// or https://',
  ),
});

const paginationSchema = z.object({
  page: z.number().int().positive().optional().default(1),
  limit: z.number().int().positive().max(100).optional().default(20),
});

const adminListReportsSchema = paginationSchema.extend({
  status: z.nativeEnum(CorpusGapReportStatus).optional(),
  jurisdiction: z.nativeEnum(CorpusGapJurisdiction).optional(),
  documentType: z.nativeEnum(CorpusGapDocumentType).optional(),
});

const adminUpdateStatusSchema = z.object({
  reportId: z.string().cuid(),
  status: z.nativeEnum(CorpusGapReportStatus),
  adminNotes: optionalTrimmedString(5000),
});

async function safe<T>(
  label: string,
  meta: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error: unknown) {
    if (error instanceof TRPCError) throw error;

    logger.error({
      type: `corpus_gap_report_${label}_error`,
      ...meta,
      error: error instanceof Error ? error.message : String(error),
    });

    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: sanitizeErrorMessage(error, 'Failed to process corpus gap report request.'),
    });
  }
}

export const corpusGapReportRouter = router({
  submitReport: orgMemberProcedure
    .input(submitReportSchema)
    .mutation(async ({ input, ctx }) => safe(
      'submit',
      { userId: ctx.user!.id, organizationId: ctx.orgMembership!.organizationId },
      () => corpusGapReportService.submitReport({
        organizationId: ctx.orgMembership!.organizationId,
        userId: ctx.user!.id,
        input,
      }),
    )),

  listMyReports: orgMemberProcedure
    .input(paginationSchema)
    .query(async ({ input, ctx }) => safe(
      'list_my',
      { userId: ctx.user!.id, organizationId: ctx.orgMembership!.organizationId },
      () => corpusGapReportService.listMyReports({
        organizationId: ctx.orgMembership!.organizationId,
        input,
      }),
    )),

  adminListReports: adminProcedure
    .input(adminListReportsSchema)
    .query(async ({ input, ctx }) => safe(
      'admin_list',
      { adminUserId: ctx.user!.id },
      () => corpusGapReportService.adminListReports({ input }),
    )),

  adminGetReport: adminProcedure
    .input(z.object({ reportId: z.string().cuid() }))
    .query(async ({ input, ctx }) => safe(
      'admin_get_report',
      { adminUserId: ctx.user!.id, reportId: input.reportId },
      () => corpusGapReportService.adminGetReport({ input }),
    )),

  adminUpdateStatus: adminProcedure
    .input(adminUpdateStatusSchema)
    .mutation(async ({ input, ctx }) => safe(
      'admin_update_status',
      { adminUserId: ctx.user!.id, reportId: input.reportId },
      () => corpusGapReportService.adminUpdateStatus({
        adminUserId: ctx.user!.id,
        input,
      }),
    )),
});
