import { TRPCError } from '@trpc/server';
import { router, adminProcedure } from '../trpc/trpc';
import {
  adminListMonitorsSchema,
  adminGetMonitorSchema,
  adminCreateMonitorSchema,
  adminUpdateMonitorSchema,
  adminSetMonitorStatusSchema,
  adminVerifyMonitorSchema,
  adminDeleteMonitorSchema,
  adminListSourceItemsSchema,
  adminGetSourceItemSchema,
  adminDismissSourceItemSchema,
  adminRunMonitorNowSchema,
  adminListDiscoveryRunsSchema,
} from '../schemas/blog-automation.schema';
import { runSourceDiscoveryForMonitor } from '../../modules/blog-automation/source-discovery.service';

export const blogAutomationRouter = router({
  adminListMonitors: adminProcedure
    .input(adminListMonitorsSchema)
    .query(async ({ input, ctx }) => {
      const {
        jurisdiction,
        authorityType,
        sourceType,
        monitoringMethod,
        status,
        isActive,
        search,
        page,
        limit,
      } = input;
      const skip = (page - 1) * limit;

      const where: any = { deletedAt: null };

      if (jurisdiction) where.jurisdiction = jurisdiction;
      if (authorityType) where.authorityType = authorityType;
      if (sourceType) where.sourceType = sourceType;
      if (monitoringMethod) where.monitoringMethod = monitoringMethod;
      if (status) where.status = status;
      if (isActive !== undefined) where.isActive = isActive;

      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { baseUrl: { contains: search, mode: 'insensitive' } },
          { feedUrl: { contains: search, mode: 'insensitive' } },
        ];
      }

      const [monitors, total] = await Promise.all([
        ctx.prisma.blogSourceMonitor.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            createdBy: { select: { id: true, fullName: true } },
            updatedBy: { select: { id: true, fullName: true } },
            verifiedBy: { select: { id: true, fullName: true } },
          },
        }),
        ctx.prisma.blogSourceMonitor.count({ where }),
      ]);

      return {
        monitors,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      };
    }),

  adminGetMonitor: adminProcedure
    .input(adminGetMonitorSchema)
    .query(async ({ input, ctx }) => {
      const monitor = await ctx.prisma.blogSourceMonitor.findUnique({
        where: { id: input.id },
        include: {
          createdBy: { select: { id: true, fullName: true } },
          updatedBy: { select: { id: true, fullName: true } },
          verifiedBy: { select: { id: true, fullName: true } },
        },
      });

      if (!monitor || monitor.deletedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Monitor not found' });
      }

      return monitor;
    }),

  adminCreateMonitor: adminProcedure
    .input(adminCreateMonitorSchema)
    .mutation(async ({ input, ctx }) => {
      // Check baseUrl uniqueness per jurisdiction
      const existing = await ctx.prisma.blogSourceMonitor.findUnique({
        where: {
          jurisdiction_baseUrl: {
            jurisdiction: input.jurisdiction,
            baseUrl: input.baseUrl,
          },
        },
      });

      if (existing && !existing.deletedAt) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A monitor with this base URL already exists in this jurisdiction.',
        });
      }

      return ctx.prisma.blogSourceMonitor.create({
        data: {
          ...input,
          createdById: ctx.user!.id,
          updatedById: ctx.user!.id,
          status: 'NEEDS_VERIFICATION',
          isActive: false,
          lastRunStatus: 'NEVER_RUN',
        },
      });
    }),

  adminUpdateMonitor: adminProcedure
    .input(adminUpdateMonitorSchema)
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;

      const monitor = await ctx.prisma.blogSourceMonitor.findUnique({
        where: { id },
      });

      if (!monitor || monitor.deletedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Monitor not found' });
      }

      if (data.baseUrl && data.baseUrl !== monitor.baseUrl) {
        const existing = await ctx.prisma.blogSourceMonitor.findUnique({
          where: {
            jurisdiction_baseUrl: {
              jurisdiction: data.jurisdiction ?? monitor.jurisdiction,
              baseUrl: data.baseUrl,
            },
          },
        });

        if (existing && existing.id !== id && !existing.deletedAt) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'A monitor with this base URL already exists in this jurisdiction.',
          });
        }
      }

      return ctx.prisma.blogSourceMonitor.update({
        where: { id },
        data: {
          ...data,
          updatedById: ctx.user!.id,
        },
      });
    }),

  adminSetMonitorStatus: adminProcedure
    .input(adminSetMonitorStatusSchema)
    .mutation(async ({ input, ctx }) => {
      const { id, status, isActive } = input;

      const monitor = await ctx.prisma.blogSourceMonitor.findUnique({
        where: { id },
      });

      if (!monitor || monitor.deletedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Monitor not found' });
      }

      const updates: any = {
        status,
        updatedById: ctx.user!.id,
      };

      if (isActive !== undefined) {
        updates.isActive = isActive;
      }

      if (status === 'ACTIVE' || updates.isActive === true) {
        if (!monitor.baseUrl) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Monitor must have a valid base URL to be active.',
          });
        }
        if (monitor.verificationStatus !== 'VERIFIED') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Monitor must be VERIFIED before it can be activated.',
          });
        }
      }

      return ctx.prisma.blogSourceMonitor.update({
        where: { id },
        data: updates,
      });
    }),

  adminVerifyMonitor: adminProcedure
    .input(adminVerifyMonitorSchema)
    .mutation(async ({ input, ctx }) => {
      const { id, notes } = input;

      const monitor = await ctx.prisma.blogSourceMonitor.findUnique({
        where: { id },
      });

      if (!monitor || monitor.deletedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Monitor not found' });
      }

      const updatedNotes = notes
        ? monitor.notes
          ? `${monitor.notes}\n\n[Verification Note]: ${notes}`
          : `[Verification Note]: ${notes}`
        : monitor.notes;

      return ctx.prisma.blogSourceMonitor.update({
        where: { id },
        data: {
          verificationStatus: 'VERIFIED',
          verifiedAt: new Date(),
          verifiedById: ctx.user!.id,
          status: 'INACTIVE', // Moving from NEEDS_VERIFICATION to INACTIVE, ready to be activated
          notes: updatedNotes,
          updatedById: ctx.user!.id,
        },
      });
    }),

  adminDeleteMonitor: adminProcedure
    .input(adminDeleteMonitorSchema)
    .mutation(async ({ input, ctx }) => {
      return ctx.prisma.blogSourceMonitor.update({
        where: { id: input.id },
        data: {
          deletedAt: new Date(),
          isActive: false,
          updatedById: ctx.user!.id,
        },
      });
    }),

  adminListSourceItems: adminProcedure
    .input(adminListSourceItemsSchema)
    .query(async ({ input, ctx }) => {
      const { monitorId, jurisdiction, authorityType, sourceType, status, search, page, limit } = input;
      const skip = (page - 1) * limit;

      const where: any = { deletedAt: null };

      if (monitorId) where.monitorId = monitorId;
      if (jurisdiction) where.jurisdiction = jurisdiction;
      if (authorityType) where.authorityType = authorityType;
      if (sourceType) where.sourceType = sourceType;
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { title: { contains: search, mode: 'insensitive' } },
          { summary: { contains: search, mode: 'insensitive' } },
        ];
      }

      const [items, total] = await Promise.all([
        ctx.prisma.blogSourceItem.findMany({
          where,
          skip,
          take: limit,
          orderBy: { discoveredAt: 'desc' },
          include: {
            monitor: { select: { id: true, name: true, jurisdiction: true, authorityType: true } },
          },
        }),
        ctx.prisma.blogSourceItem.count({ where }),
      ]);

      return {
        items,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      };
    }),

  adminGetSourceItem: adminProcedure
    .input(adminGetSourceItemSchema)
    .query(async ({ input, ctx }) => {
      const item = await ctx.prisma.blogSourceItem.findUnique({
        where: { id: input.id },
        include: {
          monitor: true,
        },
      });

      if (!item || item.deletedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Source item not found' });
      }

      return item;
    }),

  adminDismissSourceItem: adminProcedure
    .input(adminDismissSourceItemSchema)
    .mutation(async ({ input, ctx }) => {
      return ctx.prisma.blogSourceItem.update({
        where: { id: input.id },
        data: {
          status: 'DISMISSED',
          dismissedReason: input.reason,
        },
      });
    }),

  adminRunMonitorNow: adminProcedure
    .input(adminRunMonitorNowSchema)
    .mutation(async ({ input, ctx }) => {
      // Logic relies on runSourceDiscoveryForMonitor which will do validation
      return runSourceDiscoveryForMonitor({
        monitorId: input.monitorId,
        triggeredBy: 'ADMIN',
        triggeredByUserId: ctx.user!.id,
      });
    }),

  adminListDiscoveryRuns: adminProcedure
    .input(adminListDiscoveryRunsSchema)
    .query(async ({ input, ctx }) => {
      const { monitorId, status, page, limit } = input;
      const skip = (page - 1) * limit;

      const where: any = {};
      if (monitorId) where.monitorId = monitorId;
      if (status) where.status = status;

      const [runs, total] = await Promise.all([
        ctx.prisma.blogDiscoveryRun.findMany({
          where,
          skip,
          take: limit,
          orderBy: { startedAt: 'desc' },
          include: {
            monitor: { select: { id: true, name: true } },
            triggeredByUser: { select: { id: true, fullName: true } },
          },
        }),
        ctx.prisma.blogDiscoveryRun.count({ where }),
      ]);

      return {
        runs,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      };
    }),
});
