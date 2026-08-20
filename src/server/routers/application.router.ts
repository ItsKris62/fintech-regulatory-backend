import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import { router, orgMemberProcedure } from '../trpc/trpc';
import {
  addApplicationDocumentSchema,
  addApplicationFeeSchema,
  addRegulatorFeedbackSchema,
  addTimelineEventSchema,
  createApplicationSchema,
  getApplicationSchema,
  listApplicationsSchema,
  updateApplicationSchema,
} from '../schemas/application.schema';
import { logger } from '@/utils/logger';

async function assertApplicationAccess(ctx: any, applicationId: string) {
  const application = await ctx.prisma.regulatoryApplication.findFirst({
    where: {
      id: applicationId,
      organizationId: ctx.orgMembership!.organizationId,
      deletedAt: null,
    },
    select: { id: true, organizationId: true },
  });

  if (!application) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Application not found or inaccessible.',
    });
  }

  return application;
}

export const applicationRouter = router({
  list: orgMemberProcedure
    .input(listApplicationsSchema)
    .query(async ({ input, ctx }) => {
      const organizationId = ctx.orgMembership!.organizationId;
      const skip = (input.page - 1) * input.limit;
      const where: Prisma.RegulatoryApplicationWhereInput = {
        organizationId,
        deletedAt: null,
      };

      if (input.status) where.status = input.status;
      if (input.jurisdictionCode) where.jurisdictionCode = input.jurisdictionCode;
      if (input.search) {
        where.OR = [
          { title: { contains: input.search, mode: 'insensitive' } },
          { regulator: { contains: input.search, mode: 'insensitive' } },
          { licenseType: { contains: input.search, mode: 'insensitive' } },
          { referenceNumber: { contains: input.search, mode: 'insensitive' } },
        ];
      }

      const [applications, total] = await Promise.all([
        ctx.prisma.regulatoryApplication.findMany({
          where,
          skip,
          take: input.limit,
          orderBy: { updatedAt: 'desc' },
          include: {
            _count: { select: { documents: true, fees: true, regulatorFeedback: true, timelineEvents: true } },
          },
        }),
        ctx.prisma.regulatoryApplication.count({ where }),
      ]);

      return {
        applications,
        stats: {
          total,
          inProgress: await ctx.prisma.regulatoryApplication.count({ where: { organizationId, deletedAt: null, status: { in: ['DRAFT', 'IN_PROGRESS'] } } }),
          submitted: await ctx.prisma.regulatoryApplication.count({ where: { organizationId, deletedAt: null, status: { in: ['SUBMITTED', 'AWAITING_FEEDBACK'] } } }),
          approved: await ctx.prisma.regulatoryApplication.count({ where: { organizationId, deletedAt: null, status: 'APPROVED' } }),
        },
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          pages: Math.ceil(total / input.limit),
        },
      };
    }),

  get: orgMemberProcedure
    .input(getApplicationSchema)
    .query(async ({ input, ctx }) => {
      await assertApplicationAccess(ctx, input.id);
      return ctx.prisma.regulatoryApplication.findUnique({
        where: { id: input.id },
        include: {
          user: { select: { id: true, fullName: true, email: true } },
          timelineEvents: { orderBy: [{ eventDate: 'asc' }, { createdAt: 'asc' }] },
          documents: { orderBy: { createdAt: 'asc' } },
          fees: { orderBy: { createdAt: 'asc' } },
          regulatorFeedback: { orderBy: { receivedAt: 'desc' } },
        },
      });
    }),

  create: orgMemberProcedure
    .input(createApplicationSchema)
    .mutation(async ({ input, ctx }) => {
      const application = await ctx.prisma.regulatoryApplication.create({
        data: {
          ...input,
          organizationId: ctx.orgMembership!.organizationId,
          userId: ctx.user!.id,
        },
      });

      await ctx.prisma.applicationTimelineEvent.create({
        data: {
          applicationId: application.id,
          userId: ctx.user!.id,
          title: 'Application record created',
          description: 'Initial tracking record created in SheriaBot.',
          completed: true,
        },
      });

      logger.info({
        type: 'application_created',
        userId: ctx.user!.id,
        applicationId: application.id,
        jurisdictionCode: application.jurisdictionCode,
      });
      return application;
    }),

  update: orgMemberProcedure
    .input(updateApplicationSchema)
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      await assertApplicationAccess(ctx, id);
      const application = await ctx.prisma.regulatoryApplication.update({
        where: { id },
        data,
      });
      logger.info({ type: 'application_updated', userId: ctx.user!.id, applicationId: id, fields: Object.keys(data) });
      return application;
    }),

  delete: orgMemberProcedure
    .input(getApplicationSchema)
    .mutation(async ({ input, ctx }) => {
      await assertApplicationAccess(ctx, input.id);
      await ctx.prisma.regulatoryApplication.update({
        where: { id: input.id },
        data: { deletedAt: new Date() },
      });
      logger.info({ type: 'application_deleted', userId: ctx.user!.id, applicationId: input.id });
      return { success: true };
    }),

  addTimelineEvent: orgMemberProcedure
    .input(addTimelineEventSchema)
    .mutation(async ({ input, ctx }) => {
      await assertApplicationAccess(ctx, input.applicationId);
      return ctx.prisma.applicationTimelineEvent.create({
        data: {
          applicationId: input.applicationId,
          userId: ctx.user!.id,
          title: input.title,
          description: input.description,
          eventDate: input.eventDate,
          completed: input.completed,
        },
      });
    }),

  addDocument: orgMemberProcedure
    .input(addApplicationDocumentSchema)
    .mutation(async ({ input, ctx }) => {
      await assertApplicationAccess(ctx, input.applicationId);
      return ctx.prisma.applicationDocument.create({
        data: { ...input, userId: ctx.user!.id },
      });
    }),

  addFee: orgMemberProcedure
    .input(addApplicationFeeSchema)
    .mutation(async ({ input, ctx }) => {
      await assertApplicationAccess(ctx, input.applicationId);
      return ctx.prisma.applicationFee.create({
        data: { ...input, userId: ctx.user!.id },
      });
    }),

  addRegulatorFeedback: orgMemberProcedure
    .input(addRegulatorFeedbackSchema)
    .mutation(async ({ input, ctx }) => {
      await assertApplicationAccess(ctx, input.applicationId);
      return ctx.prisma.applicationRegulatorFeedback.create({
        data: { ...input, userId: ctx.user!.id },
      });
    }),
});
