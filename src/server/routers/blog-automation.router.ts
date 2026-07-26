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
  adminScoreSourceItemSchema,
  adminScoreEligibleSourceItemsSchema,
  adminListSuggestionsSchema,
  adminGetSuggestionSchema,
  adminDismissSuggestionSchema,
  adminApproveSuggestionForDraftSchema,
  adminMarkSuggestionNeedsMoreSourcesSchema,
  adminDeleteSuggestionSchema,
  adminCreateDraftFromSuggestionSchema,
  adminGenerateAiDraftSchema,
  adminRunBlogVerificationSchema,
  adminListBlogVerificationRunsSchema,
  adminGetBlogVerificationRunSchema,
  adminGetLatestBlogVerificationSchema,
  adminListEditorialDigestsSchema,
  adminGetEditorialDigestSchema,
  adminGenerateEditorialDigestSchema,
} from '../schemas/blog-automation.schema';
import { runSourceDiscoveryForMonitor } from '../../modules/blog-automation/source-discovery.service';
import { createSuggestionFromSourceItem } from '../../modules/blog-automation/suggestion-builder';
import { createBlogDraftFromSuggestion } from '../../modules/blog-automation/draft-creation.service';
import { generateAiDraftForBlogPost } from '../../modules/blog-automation/ai-draft-generation.service';
import { runBlogPostVerification } from '../../modules/blog-automation/blog-verification.service';
import { blogEditorialDigestService } from '../../modules/blog-automation/blog-editorial-digest.service';

export const blogAutomationRouter = router({
  adminListMonitors: adminProcedure
    .input(adminListMonitorsSchema)
    .query(async ({ input, ctx }): Promise<any> => {
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
    .query(async ({ input, ctx }): Promise<any> => {
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
    .mutation(async ({ input, ctx }): Promise<any> => {
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
    .mutation(async ({ input, ctx }): Promise<any> => {
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
    .mutation(async ({ input, ctx }): Promise<any> => {
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
    .mutation(async ({ input, ctx }): Promise<any> => {
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
    .mutation(async ({ input, ctx }): Promise<any> => {
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
    .query(async ({ input, ctx }): Promise<any> => {
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
    .query(async ({ input, ctx }): Promise<any> => {
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
    .mutation(async ({ input, ctx }): Promise<any> => {
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
    .mutation(async ({ input, ctx }): Promise<any> => {
      // Logic relies on runSourceDiscoveryForMonitor which will do validation
      return runSourceDiscoveryForMonitor({
        prisma: ctx.prisma,
        monitorId: input.monitorId,
        triggeredBy: 'ADMIN',
        triggeredByUserId: ctx.user!.id,
      });
    }),

  adminListDiscoveryRuns: adminProcedure
    .input(adminListDiscoveryRunsSchema)
    .query(async ({ input, ctx }): Promise<any> => {
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

  adminScoreSourceItem: adminProcedure
    .input(adminScoreSourceItemSchema)
    .mutation(async ({ input, ctx }): Promise<any> => {
      const result = await createSuggestionFromSourceItem({
        prisma: ctx.prisma,
        sourceItemId: input.sourceItemId,
        minScore: input.minScore ?? 45,
        createdByUserId: ctx.user!.id,
      });
      return result;
    }),

  adminScoreEligibleSourceItems: adminProcedure
    .input(adminScoreEligibleSourceItemsSchema)
    .mutation(async ({ input, ctx }): Promise<any> => {
      const { minScore = 45, limit = 50, jurisdiction, monitorId } = input;
      
      const where: any = {
        deletedAt: null,
        status: { in: ['NEW', 'READY_FOR_SCORING'] },
      };
      
      if (jurisdiction) where.jurisdiction = jurisdiction;
      if (monitorId) where.monitorId = monitorId;

      const items = await ctx.prisma.blogSourceItem.findMany({
        where,
        take: limit,
        orderBy: { discoveredAt: 'asc' },
      });

      const summary = {
        processed: 0,
        suggestionsCreated: 0,
        belowThreshold: 0,
        duplicatesSkipped: 0,
        failures: 0,
      };

      for (const item of items) {
        summary.processed++;
        try {
          const res = await createSuggestionFromSourceItem({
            prisma: ctx.prisma,
            sourceItemId: item.id,
            minScore,
            createdByUserId: ctx.user!.id,
          });
          if (res.createdSuggestion) {
            summary.suggestionsCreated++;
          } else if (res.reason === 'Duplicate') {
            summary.duplicatesSkipped++;
          } else {
            summary.belowThreshold++;
          }
        } catch (e) {
          summary.failures++;
        }
      }

      return summary;
    }),

  adminListSuggestions: adminProcedure
    .input(adminListSuggestionsSchema)
    .query(async ({ input, ctx }): Promise<any> => {
      const { status, priority, jurisdiction, category, articleType, search, page, limit } = input;
      const skip = (page - 1) * limit;

      const where: any = { deletedAt: null };

      if (status) where.status = status;
      if (priority) where.priority = priority;
      if (jurisdiction) where.jurisdiction = jurisdiction;
      if (category) where.category = category;
      if (articleType) where.articleType = articleType;

      if (search) {
        where.OR = [
          { title: { contains: search, mode: 'insensitive' } },
          { summary: { contains: search, mode: 'insensitive' } },
        ];
      }

      const [suggestions, total] = await Promise.all([
        ctx.prisma.blogArticleSuggestion.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            sources: {
              include: {
                sourceItem: {
                  include: { monitor: { select: { id: true, name: true } } }
                }
              }
            }
          },
        }),
        ctx.prisma.blogArticleSuggestion.count({ where }),
      ]);

      return {
        suggestions,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      };
    }),

  adminGetSuggestion: adminProcedure
    .input(adminGetSuggestionSchema)
    .query(async ({ input, ctx }): Promise<any> => {
      const suggestion = await ctx.prisma.blogArticleSuggestion.findUnique({
        where: { id: input.id },
        include: {
          sources: {
            include: {
              sourceItem: {
                include: { monitor: true }
              }
            }
          },
          dismissedBy: { select: { id: true, fullName: true } },
          approvedBy: { select: { id: true, fullName: true } },
        },
      });

      if (!suggestion || suggestion.deletedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Suggestion not found' });
      }

      return suggestion;
    }),

  adminDismissSuggestion: adminProcedure
    .input(adminDismissSuggestionSchema)
    .mutation(async ({ input, ctx }): Promise<any> => {
      return ctx.prisma.blogArticleSuggestion.update({
        where: { id: input.id },
        data: {
          status: 'DISMISSED',
          dismissedReason: input.reason,
          dismissedAt: new Date(),
          dismissedById: ctx.user!.id,
        },
      });
    }),

  adminApproveSuggestionForDraft: adminProcedure
    .input(adminApproveSuggestionForDraftSchema)
    .mutation(async ({ input, ctx }): Promise<any> => {
      return ctx.prisma.blogArticleSuggestion.update({
        where: { id: input.id },
        data: {
          status: 'APPROVED_FOR_DRAFT',
          approvedAt: new Date(),
          approvedById: ctx.user!.id,
        },
      });
    }),

  adminMarkSuggestionNeedsMoreSources: adminProcedure
    .input(adminMarkSuggestionNeedsMoreSourcesSchema)
    .mutation(async ({ input, ctx }): Promise<any> => {
      const suggestion = await ctx.prisma.blogArticleSuggestion.findUnique({ where: { id: input.id } });
      if (!suggestion) throw new TRPCError({ code: 'NOT_FOUND', message: 'Not found' });
      
      const newAction = input.reason 
        ? `${suggestion.suggestedNextAction}\n\n[Needs Sources Note]: ${input.reason}`
        : suggestion.suggestedNextAction;

      return ctx.prisma.blogArticleSuggestion.update({
        where: { id: input.id },
        data: {
          status: 'NEEDS_MORE_SOURCES',
          needsMoreSources: true,
          suggestedNextAction: newAction,
        },
      });
    }),

  adminDeleteSuggestion: adminProcedure
    .input(adminDeleteSuggestionSchema)
    .mutation(async ({ input, ctx }): Promise<any> => {
      return ctx.prisma.blogArticleSuggestion.update({
        where: { id: input.id },
        data: {
          deletedAt: new Date(),
        },
      });
    }),

  adminCreateDraftFromSuggestion: adminProcedure
    .input(adminCreateDraftFromSuggestionSchema)
    .mutation(async ({ input, ctx }): Promise<any> => {
      return createBlogDraftFromSuggestion({
        prisma: ctx.prisma,
        suggestionId: input.suggestionId,
        createdById: ctx.user!.id,
      });
    }),

  adminGenerateAiDraft: adminProcedure
    .input(adminGenerateAiDraftSchema)
    .mutation(async ({ input, ctx }): Promise<any> => {
      return generateAiDraftForBlogPost(input.blogPostId, ctx.user!.id);
    }),

  adminRunBlogVerification: adminProcedure
    .input(adminRunBlogVerificationSchema)
    .mutation(async ({ input, ctx }): Promise<any> => {
      return runBlogPostVerification({
        prisma: ctx.prisma,
        blogPostId: input.blogPostId,
        requestedByUserId: ctx.user!.id,
        runType: input.runType,
        useAiReview: input.useAiReview
      });
    }),

  adminListBlogVerificationRuns: adminProcedure
    .input(adminListBlogVerificationRunsSchema)
    .query(async ({ input, ctx }): Promise<any> => {
      const { blogPostId, status, page, limit } = input;
      const skip = (page - 1) * limit;

      const where: any = {};
      if (blogPostId) where.blogPostId = blogPostId;
      if (status) where.status = status;

      const [runs, total] = await Promise.all([
        ctx.prisma.blogVerificationRun.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            requestedBy: { select: { id: true, fullName: true } }
          }
        }),
        ctx.prisma.blogVerificationRun.count({ where })
      ]);

      return {
        runs,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      };
    }),

  adminGetBlogVerificationRun: adminProcedure
    .input(adminGetBlogVerificationRunSchema)
    .query(async ({ input, ctx }): Promise<any> => {
      const run = await ctx.prisma.blogVerificationRun.findUnique({
        where: { id: input.id },
        include: {
          issues: true,
          requestedBy: { select: { id: true, fullName: true } },
          blogPost: { select: { id: true, title: true } }
        }
      });
      if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'Verification run not found' });
      return run;
    }),

  adminGetLatestBlogVerification: adminProcedure
    .input(adminGetLatestBlogVerificationSchema)
    .query(async ({ input, ctx }): Promise<any> => {
      const run = await ctx.prisma.blogVerificationRun.findFirst({
        where: { blogPostId: input.blogPostId },
        orderBy: { createdAt: 'desc' },
        include: { issues: true }
      });
      
      if (!run) {
        return { run: null, isStale: false, isAiStale: false };
      }

      const post = await ctx.prisma.blogPost.findUnique({
        where: { id: input.blogPostId },
        include: {
          sources: true,
          draftGenerationRuns: {
            orderBy: { createdAt: 'desc' },
            take: 1
          }
        }
      });

      if (!post) {
        return { run, isStale: false, isAiStale: false };
      }

      let isStale = false;
      let isAiStale = false;
      const verificationTime = run.completedAt || run.createdAt;

      if (post.updatedAt > verificationTime) {
        isStale = true;
      }

      for (const source of post.sources) {
        if (source.updatedAt > verificationTime) {
          isStale = true;
          break;
        }
      }

      const latestAiDraft = post.draftGenerationRuns[0];
      if (latestAiDraft) {
        const draftTime = latestAiDraft.createdAt;
        if (draftTime > verificationTime) {
          isStale = true;
          isAiStale = true;
        }
      }

      return { run, isStale, isAiStale };
    }),

  adminListEditorialDigests: adminProcedure
    .input(adminListEditorialDigestsSchema)
    .query(async ({ input }): Promise<any> => {
      const result = await blogEditorialDigestService.getDigests(input.page, input.limit);
      return {
        items: result.items.map((item) => ({
          id: item.id,
          periodStart: item.periodStart.toISOString(),
          periodEnd: item.periodEnd.toISOString(),
          status: item.status,
          sourceMonitorsChecked: item.sourceMonitorsChecked,
          sourceItemsDiscovered: item.sourceItemsDiscovered,
          highPrioritySuggestions: item.highPrioritySuggestions,
          urgentSuggestions: item.urgentSuggestions,
          approvedAwaitingDraft: item.approvedAwaitingDraft,
          draftsAwaitingVerification: item.draftsAwaitingVerification,
          blockedDrafts: item.blockedDrafts,
          failingMonitors: item.failingMonitors as any,
          createdAt: item.createdAt.toISOString(),
        })),
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      };
    }),

  adminGetEditorialDigest: adminProcedure
    .input(adminGetEditorialDigestSchema)
    .query(async ({ input }): Promise<any> => {
      const item = await blogEditorialDigestService.getDigestById(input.id);
      return {
        id: item.id,
        periodStart: item.periodStart.toISOString(),
        periodEnd: item.periodEnd.toISOString(),
        status: item.status,
        sourceMonitorsChecked: item.sourceMonitorsChecked,
        sourceItemsDiscovered: item.sourceItemsDiscovered,
        highPrioritySuggestions: item.highPrioritySuggestions,
        urgentSuggestions: item.urgentSuggestions,
        approvedAwaitingDraft: item.approvedAwaitingDraft,
        draftsAwaitingVerification: item.draftsAwaitingVerification,
        blockedDrafts: item.blockedDrafts,
        failingMonitors: item.failingMonitors as any,
        createdAt: item.createdAt.toISOString(),
      };
    }),

  adminGenerateEditorialDigest: adminProcedure
    .input(adminGenerateEditorialDigestSchema)
    .mutation(async ({ input }): Promise<any> => {
      const item = await blogEditorialDigestService.generateBlogEditorialDigest({
        force: input.force,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      });
      return {
        id: item.id,
        status: item.status,
        createdAt: item.createdAt.toISOString(),
      };
    }),
});

