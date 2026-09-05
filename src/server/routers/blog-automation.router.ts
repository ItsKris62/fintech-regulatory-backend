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
  adminListEditorialTriageRunsSchema,
  adminGetEditorialTriageRunSchema,
  adminListResearchPackVersionsSchema,
  adminGetResearchPackSchema,
  adminReviewResearchPackSchema,
  adminListFreshnessReviewsSchema,
  adminGetFreshnessReviewSchema,
  adminListRevisionRequestsSchema,
  adminGetRevisionRequestSchema,
  adminAssignRevisionRequestSchema,
  adminAcceptRevisionRequestSchema,
  adminStartRevisionRequestSchema,
  adminResolveRevisionRequestSchema,
  adminDismissRevisionRequestSchema,
  adminListContentOpsAlertsSchema,
  adminGetContentOpsAlertSchema,
  adminAcknowledgeContentOpsAlertSchema,
  adminResolveContentOpsAlertSchema,
  adminIgnoreContentOpsAlertSchema,
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
      const {
        status,
        priority,
        jurisdiction,
        authorityType,
        category,
        articleType,
        search,
        sortBy = 'score',
        sortOrder = 'desc',
        minScore,
        maxScore,
        page,
        limit,
      } = input;
      const skip = (page - 1) * limit;

      const where: any = { deletedAt: null };

      if (status) where.status = status;
      if (priority) where.priority = priority;
      if (jurisdiction) where.jurisdiction = jurisdiction;
      if (category) where.category = category;
      if (articleType) where.articleType = articleType;

      if (authorityType) {
        where.sources = {
          some: {
            sourceItem: {
              authorityType,
            },
          },
        };
      }

      if (minScore !== undefined || maxScore !== undefined) {
        where.relevanceScore = {};
        if (minScore !== undefined) where.relevanceScore.gte = minScore;
        if (maxScore !== undefined) where.relevanceScore.lte = maxScore;
      }

      if (search) {
        where.OR = [
          { title: { contains: search, mode: 'insensitive' } },
          { summary: { contains: search, mode: 'insensitive' } },
        ];
      }

      let orderBy: any[];
      if (sortBy === 'relevanceScore' || sortBy === 'score') {
        orderBy = [
          { relevanceScore: sortOrder },
          { createdAt: 'desc' },
          { id: 'desc' },
        ];
      } else if (sortBy === 'createdAt') {
        orderBy = [
          { createdAt: sortOrder },
          { id: 'desc' },
        ];
      } else {
        orderBy = [
          { relevanceScore: 'desc' },
          { createdAt: 'desc' },
          { id: 'desc' },
        ];
      }

      const [suggestions, total] = await Promise.all([
        ctx.prisma.blogArticleSuggestion.findMany({
          where,
          skip,
          take: limit,
          orderBy,
          include: {
            sources: {
              include: {
                sourceItem: {
                  include: { monitor: { select: { id: true, name: true, authorityType: true, baseUrl: true } } },
                },
              },
            },
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

  adminListEditorialTriageRuns: adminProcedure
    .input(adminListEditorialTriageRunsSchema)
    .query(async ({ input, ctx }) => {
      const { page, limit } = input;
      const skip = (page - 1) * limit;
      const where: any = {};
      const [runs, total] = await Promise.all([
        ctx.prisma.blogEditorialTriageRun.findMany({
          where, skip, take: limit, orderBy: { createdAt: 'desc' },
          include: { sourceItem: true, suggestion: true }
        }),
        ctx.prisma.blogEditorialTriageRun.count({ where })
      ]);
      return { runs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
    }),

  adminGetEditorialTriageRun: adminProcedure
    .input(adminGetEditorialTriageRunSchema)
    .query(async ({ input, ctx }) => {
      const run = await ctx.prisma.blogEditorialTriageRun.findUnique({
        where: { id: input.id },
        include: { sourceItem: true, suggestion: true }
      });
      if (!run) throw new TRPCError({ code: 'NOT_FOUND' });
      return run;
    }),

  adminListResearchPackVersions: adminProcedure
    .input(adminListResearchPackVersionsSchema)
    .query(async ({ input, ctx }) => {
      const { blogPostId, page, limit } = input;
      const skip = (page - 1) * limit;
      const where: any = {};
      if (blogPostId) where.blogPostId = blogPostId;
      const [packs, total] = await Promise.all([
        ctx.prisma.blogResearchPack.findMany({
          where, skip, take: limit, orderBy: { version: 'desc' },
          include: {
            blogPost: { select: { id: true, title: true } },
            reviewedBy: { select: { id: true, fullName: true } }
          }
        }),
        ctx.prisma.blogResearchPack.count({ where })
      ]);
      return { packs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
    }),

  adminGetResearchPack: adminProcedure
    .input(adminGetResearchPackSchema)
    .query(async ({ input, ctx }) => {
      const pack = await ctx.prisma.blogResearchPack.findUnique({
        where: { id: input.id },
        include: {
          blogPost: { select: { id: true, title: true } },
          reviewedBy: { select: { id: true, fullName: true } },
          sources: true
        }
      });
      if (!pack) throw new TRPCError({ code: 'NOT_FOUND' });
      return pack;
    }),

  adminReviewResearchPack: adminProcedure
    .input(adminReviewResearchPackSchema)
    .mutation(async ({ input, ctx }) => {
      return ctx.prisma.$transaction(async (tx) => {
        const { count } = await tx.blogResearchPack.updateMany({
          where: { id: input.id, status: 'COMPLETE', reviewerStatus: 'PENDING' },
          data: {
            reviewerStatus: input.status,
            reviewedById: ctx.user!.id,
            reviewedAt: new Date()
          }
        });

        if (count === 0) {
          throw new TRPCError({ 
            code: 'BAD_REQUEST', 
            message: 'Pack already reviewed or not ready (must be COMPLETE and PENDING review)' 
          });
        }

        await tx.auditLog.create({
          data: {
            userId: ctx.user!.id,
            action: 'REVIEW_RESEARCH_PACK',
            entityId: input.id,
            entityType: 'BlogResearchPack',
            metadata: { decision: input.status, note: input.note }
          }
        });

        return tx.blogResearchPack.findUnique({ where: { id: input.id } });
      });
    }),

  adminGetFreshnessReview: adminProcedure
    .input(adminGetFreshnessReviewSchema)
    .query(async ({ input, ctx }) => {
      const review = await ctx.prisma.blogFreshnessReview.findUnique({
        where: { id: input.id },
        include: { blogPost: { select: { id: true, title: true } } }
      });
      if (!review) throw new TRPCError({ code: 'NOT_FOUND' });
      return review;
    }),

  adminListFreshnessReviews: adminProcedure
    .input(adminListFreshnessReviewsSchema)
    .query(async ({ input, ctx }) => {
      const { blogPostId, page, limit } = input;
      const skip = (page - 1) * limit;
      const where: any = {};
      if (blogPostId) where.blogPostId = blogPostId;
      const [reviews, total] = await Promise.all([
        ctx.prisma.blogFreshnessReview.findMany({
          where, skip, take: limit, orderBy: { createdAt: 'desc' },
          include: { blogPost: { select: { id: true, title: true } } }
        }),
        ctx.prisma.blogFreshnessReview.count({ where })
      ]);
      return { reviews, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
    }),

  adminListRevisionRequests: adminProcedure
    .input(adminListRevisionRequestsSchema)
    .query(async ({ input, ctx }) => {
      const { blogPostId, status, page, limit } = input;
      const skip = (page - 1) * limit;
      const where: any = {};
      if (blogPostId) where.blogPostId = blogPostId;
      if (status) where.status = status;
      const [requests, total] = await Promise.all([
        ctx.prisma.blogRevisionRequest.findMany({
          where, skip, take: limit, orderBy: { createdAt: 'desc' },
          include: {
            blogPost: { select: { id: true, title: true } },
            assignedTo: { select: { id: true, fullName: true } },
            requestedBy: { select: { id: true, fullName: true } }
          }
        }),
        ctx.prisma.blogRevisionRequest.count({ where })
      ]);
      return { requests, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
    }),

  adminGetRevisionRequest: adminProcedure
    .input(adminGetRevisionRequestSchema)
    .query(async ({ input, ctx }) => {
      const request = await ctx.prisma.blogRevisionRequest.findUnique({
        where: { id: input.id },
        include: {
          blogPost: { select: { id: true, title: true } },
          assignedTo: { select: { id: true, fullName: true } },
          requestedBy: { select: { id: true, fullName: true } }
        }
      });
      if (!request) throw new TRPCError({ code: 'NOT_FOUND' });
      return request;
    }),

  adminAssignRevisionRequest: adminProcedure
    .input(adminAssignRevisionRequestSchema)
    .mutation(async ({ input, ctx }) => {
      const request = await ctx.prisma.blogRevisionRequest.findUnique({ where: { id: input.id } });
      if (!request) throw new TRPCError({ code: 'NOT_FOUND' });
      if (request.status !== 'PENDING_REVIEW') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Cannot assign a request in ${request.status} status` });
      }
      return ctx.prisma.blogRevisionRequest.update({
        where: { id: input.id },
        data: {
          assignedToId: input.assignedToId
        }
      });
    }),

  adminAcceptRevisionRequest: adminProcedure
    .input(adminAcceptRevisionRequestSchema)
    .mutation(async ({ input, ctx }) => {
      const request = await ctx.prisma.blogRevisionRequest.findUnique({ where: { id: input.id } });
      if (!request) throw new TRPCError({ code: 'NOT_FOUND' });
      if (request.status !== 'PENDING_REVIEW') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Cannot accept a request in ${request.status} status` });
      }
      return ctx.prisma.blogRevisionRequest.update({
        where: { id: input.id },
        data: {
          status: 'ACCEPTED',
          assignedToId: ctx.user!.id
        }
      });
    }),

  adminStartRevisionRequest: adminProcedure
    .input(adminStartRevisionRequestSchema)
    .mutation(async ({ input, ctx }) => {
      const request = await ctx.prisma.blogRevisionRequest.findUnique({ where: { id: input.id } });
      if (!request) throw new TRPCError({ code: 'NOT_FOUND' });
      if (request.status !== 'ACCEPTED') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Cannot start a request in ${request.status} status` });
      }
      return ctx.prisma.blogRevisionRequest.update({
        where: { id: input.id },
        data: {
          status: 'IN_PROGRESS'
        }
      });
    }),

  adminResolveRevisionRequest: adminProcedure
    .input(adminResolveRevisionRequestSchema)
    .mutation(async ({ input, ctx }) => {
      const request = await ctx.prisma.blogRevisionRequest.findUnique({ where: { id: input.id } });
      if (!request) throw new TRPCError({ code: 'NOT_FOUND' });
      if (request.status !== 'ACCEPTED' && request.status !== 'IN_PROGRESS') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Cannot resolve a request in ${request.status} status` });
      }
      return ctx.prisma.blogRevisionRequest.update({
        where: { id: input.id },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date()
        }
      });
    }),

  adminDismissRevisionRequest: adminProcedure
    .input(adminDismissRevisionRequestSchema)
    .mutation(async ({ input, ctx }) => {
      const request = await ctx.prisma.blogRevisionRequest.findUnique({ where: { id: input.id } });
      if (!request) throw new TRPCError({ code: 'NOT_FOUND' });
      return ctx.prisma.blogRevisionRequest.update({
        where: { id: input.id },
        data: {
          status: 'DISMISSED',
          resolvedAt: new Date()
        }
      });
    }),

  adminListContentOpsAlerts: adminProcedure
    .input(adminListContentOpsAlertsSchema)
    .query(async ({ input, ctx }) => {
      const { status, page, limit } = input;
      const skip = (page - 1) * limit;
      const where: any = {};
      if (status) where.status = status;
      const [alerts, total] = await Promise.all([
        ctx.prisma.contentOpsAlert.findMany({
          where, skip, take: limit, orderBy: { createdAt: 'desc' },
          include: {
            resolvedBy: { select: { id: true, fullName: true } }
          }
        }),
        ctx.prisma.contentOpsAlert.count({ where })
      ]);
      return { alerts, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
    }),

  adminGetContentOpsAlert: adminProcedure
    .input(adminGetContentOpsAlertSchema)
    .query(async ({ input, ctx }) => {
      const alert = await ctx.prisma.contentOpsAlert.findUnique({
        where: { id: input.id },
        include: {
          resolvedBy: { select: { id: true, fullName: true } }
        }
      });
      if (!alert) throw new TRPCError({ code: 'NOT_FOUND' });
      return alert;
    }),

  adminAcknowledgeContentOpsAlert: adminProcedure
    .input(adminAcknowledgeContentOpsAlertSchema)
    .mutation(async ({ input, ctx }) => {
      const alert = await ctx.prisma.contentOpsAlert.findUnique({ where: { id: input.id } });
      if (!alert) throw new TRPCError({ code: 'NOT_FOUND' });
      if (alert.status !== 'OPEN') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Cannot acknowledge an alert in ${alert.status} status` });
      }
      return ctx.prisma.contentOpsAlert.update({
        where: { id: input.id },
        data: { status: 'ACKNOWLEDGED' }
      });
    }),

  adminResolveContentOpsAlert: adminProcedure
    .input(adminResolveContentOpsAlertSchema)
    .mutation(async ({ input, ctx }) => {
      const alert = await ctx.prisma.contentOpsAlert.findUnique({ where: { id: input.id } });
      if (!alert) throw new TRPCError({ code: 'NOT_FOUND' });
      if (alert.status !== 'OPEN' && alert.status !== 'ACKNOWLEDGED') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Cannot resolve an alert in ${alert.status} status` });
      }
      return ctx.prisma.contentOpsAlert.update({
        where: { id: input.id },
        data: {
          status: 'RESOLVED',
          resolvedById: ctx.user!.id,
          resolvedAt: new Date(),
          resolutionNote: input.resolutionNotes
        }
      });
    }),

  adminIgnoreContentOpsAlert: adminProcedure
    .input(adminIgnoreContentOpsAlertSchema)
    .mutation(async ({ input, ctx }) => {
      const alert = await ctx.prisma.contentOpsAlert.findUnique({ where: { id: input.id } });
      if (!alert) throw new TRPCError({ code: 'NOT_FOUND' });
      if (alert.status !== 'OPEN' && alert.status !== 'ACKNOWLEDGED') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Cannot ignore an alert in ${alert.status} status` });
      }
      return ctx.prisma.contentOpsAlert.update({
        where: { id: input.id },
        data: {
          status: 'IGNORED',
          resolvedById: ctx.user!.id,
          resolvedAt: new Date(),
          resolutionNote: input.reason
        }
      });
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

