import { TRPCError } from '@trpc/server';
import { LicenseStatus, MemberRole } from '@prisma/client';
import { router, adminProcedure, orgMemberProcedure } from '../trpc/trpc';
import { requireOrgMembershipRole, requirePlanFeature, withPlanContext } from '../trpc/middleware';
import { licenseService } from '@/modules/license';
import { logger } from '@/utils/logger';
import {
  addDocumentSchema,
  addFeeSchema,
  addTimelineEventSchema,
  adminGetLicenseSchema,
  adminListLicensesSchema,
  adminOverrideUpdateLicenseSchema,
  archiveLicenseSchema,
  completeTimelineEventSchema,
  createLicenseSchema,
  getLicenseSchema,
  listLicensesSchema,
  removeDocumentSchema,
  upcomingLicensesSchema,
  updateFeeSchema,
  updateLicenseSchema,
  updateTimelineEventSchema,
} from '../schemas/license.schema';

function asLicenseStatus(value: string | undefined): LicenseStatus | undefined {
  return value as LicenseStatus | undefined;
}

function orgContext(ctx: any) {
  return {
    organizationId: ctx.orgMembership!.organizationId,
    actorUserId: ctx.user!.id,
    actorRole: ctx.orgMembership!.role,
  };
}

async function safe<T>(label: string, meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error: unknown) {
    if (error instanceof TRPCError) throw error;
    logger.error({ type: `license_${label}_error`, ...meta, error: String(error) });
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to process license request.' });
  }
}

const licenseOrgProcedure = orgMemberProcedure
  .use(withPlanContext)
  .use(requirePlanFeature('licenseManagement'));

const licenseManagerProcedure = licenseOrgProcedure
  .use(requireOrgMembershipRole([MemberRole.ADMIN, MemberRole.OWNER]));

export const licenseRouter = router({
  list: licenseOrgProcedure
    .input(listLicensesSchema)
    .query(async ({ input, ctx }) => safe('list', { userId: ctx.user!.id }, () => licenseService.list({
      organizationId: ctx.orgMembership!.organizationId,
      status: asLicenseStatus(input.status),
      search: input.search,
      includeArchived: input.includeArchived,
      page: input.page,
      limit: input.limit,
    }))),

  get: licenseOrgProcedure
    .input(getLicenseSchema)
    .query(async ({ input, ctx }) => safe('get', { userId: ctx.user!.id, licenseId: input.id }, () => licenseService.get({
      organizationId: ctx.orgMembership!.organizationId,
      id: input.id,
    }))),

  create: licenseManagerProcedure
    .input(createLicenseSchema)
    .mutation(async ({ input, ctx }) => safe('create', { userId: ctx.user!.id }, () => licenseService.create({
      ...orgContext(ctx),
      input,
    }))),

  update: licenseManagerProcedure
    .input(updateLicenseSchema)
    .mutation(async ({ input, ctx }) => safe('update', { userId: ctx.user!.id, licenseId: input.id }, () => licenseService.update({
      ...orgContext(ctx),
      input,
    }))),

  archive: licenseManagerProcedure
    .input(archiveLicenseSchema)
    .mutation(async ({ input, ctx }) => safe('archive', { userId: ctx.user!.id, licenseId: input.id }, () => licenseService.archive({
      ...orgContext(ctx),
      id: input.id,
    }))),

  addTimelineEvent: licenseManagerProcedure
    .input(addTimelineEventSchema)
    .mutation(async ({ input, ctx }) => safe('add_timeline_event', { userId: ctx.user!.id, licenseId: input.licenseId }, () => licenseService.addTimelineEvent({
      ...orgContext(ctx),
      input,
    }))),

  updateTimelineEvent: licenseManagerProcedure
    .input(updateTimelineEventSchema)
    .mutation(async ({ input, ctx }) => safe('update_timeline_event', { userId: ctx.user!.id, timelineEventId: input.id }, () => licenseService.updateTimelineEvent({
      ...orgContext(ctx),
      input,
    }))),

  completeTimelineEvent: licenseOrgProcedure
    .input(completeTimelineEventSchema)
    .mutation(async ({ input, ctx }) => safe('complete_timeline_event', { userId: ctx.user!.id, timelineEventId: input.id }, () => licenseService.completeTimelineEvent({
      ...orgContext(ctx),
      id: input.id,
    }))),

  addDocument: licenseManagerProcedure
    .input(addDocumentSchema)
    .mutation(async ({ input, ctx }) => safe('add_document', { userId: ctx.user!.id, licenseId: input.licenseId }, () => licenseService.addDocument({
      ...orgContext(ctx),
      input,
    }))),

  removeDocument: licenseManagerProcedure
    .input(removeDocumentSchema)
    .mutation(async ({ input, ctx }) => safe('remove_document', { userId: ctx.user!.id, documentLinkId: input.id }, () => licenseService.removeDocument({
      ...orgContext(ctx),
      id: input.id,
    }))),

  addFee: licenseManagerProcedure
    .input(addFeeSchema)
    .mutation(async ({ input, ctx }) => safe('add_fee', { userId: ctx.user!.id, licenseId: input.licenseId }, () => licenseService.addFee({
      ...orgContext(ctx),
      input,
    }))),

  updateFee: licenseManagerProcedure
    .input(updateFeeSchema)
    .mutation(async ({ input, ctx }) => safe('update_fee', { userId: ctx.user!.id, feeId: input.id }, () => licenseService.updateFee({
      ...orgContext(ctx),
      input,
    }))),

  getUpcomingRenewals: licenseOrgProcedure
    .input(upcomingLicensesSchema)
    .query(async ({ input, ctx }) => safe('upcoming', { userId: ctx.user!.id }, () => licenseService.upcoming({
      organizationId: ctx.orgMembership!.organizationId,
      daysAhead: input.daysAhead,
    }))),

  getDashboardSummary: licenseOrgProcedure
    .query(async ({ ctx }) => safe('summary', { userId: ctx.user!.id }, () => licenseService.summary({
      organizationId: ctx.orgMembership!.organizationId,
    }))),

  adminList: adminProcedure
    .input(adminListLicensesSchema)
    .query(async ({ input, ctx }) => safe('admin_list', { userId: ctx.user!.id }, () => licenseService.adminList({
      actorUserId: ctx.user!.id,
      organizationId: input.organizationId,
      status: asLicenseStatus(input.status),
      search: input.search,
      includeArchived: input.includeArchived,
      page: input.page,
      limit: input.limit,
    }))),

  adminGet: adminProcedure
    .input(adminGetLicenseSchema)
    .query(async ({ input, ctx }) => safe('admin_get', { userId: ctx.user!.id, licenseId: input.id }, () => licenseService.adminGet({
      actorUserId: ctx.user!.id,
      id: input.id,
      reason: input.reason,
    }))),

  adminOverrideUpdate: adminProcedure
    .input(adminOverrideUpdateLicenseSchema)
    .mutation(async ({ input, ctx }) => safe('admin_override_update', { userId: ctx.user!.id, licenseId: input.id }, async () => {
      const license = await ctx.prisma.license.findUnique({
        where: { id: input.id },
        select: { organizationId: true },
      });
      if (!license) throw new TRPCError({ code: 'NOT_FOUND', message: 'License not found.' });
      const { reason, ...updateInput } = input;
      return licenseService.update({
        organizationId: license.organizationId,
        actorUserId: ctx.user!.id,
        actorRole: MemberRole.OWNER,
        input: updateInput,
        adminOverrideReason: reason,
      });
    })),
});
