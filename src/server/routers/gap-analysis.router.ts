import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { createHash } from 'crypto';
import { router, protectedProcedure } from '../trpc/trpc';
import { BillingMetric, SubscriptionPlan } from '@prisma/client';
import { rateLimited, withPlanContext, requirePlanFeature, checkUsageLimit } from '../trpc/middleware';
import { complianceModule } from '@/modules/compliance';
import { logger } from '@/utils/logger';
import { NotFoundError, ForbiddenError } from '@/utils/error';
import { redis } from '@/lib/redis/client';
import { prisma } from '@/lib/prisma/client';
import { GAP_ANALYSIS_UPLOAD_LIMITS, GAP_ANALYSIS_MAX_BASE64_CHARS } from '@/config/upload-limits.config';

export const gapAnalysisRouter = router({
  /**
   * Return the list of regulatory frameworks available to the current user.
   * Each framework carries a `locked` flag when the framework's tier exceeds
   * the user's current subscription plan.
   *
   * @protected
   */
  getFrameworks: protectedProcedure
    .use(withPlanContext)
    .query(async ({ ctx }) => {
      const plan = ctx.plan ?? SubscriptionPlan.REGULATOR;

      const tierLevel: Record<string, number> = {
        REGULATOR: 3,
        STARTUP: 1,
        BUSINESS: 2,
        ENTERPRISE: 3,
      };
      const frameworkTierLevel: Record<string, number> = {
        STARTUP: 1,
        BUSINESS: 2,
        ENTERPRISE: 3,
      };
      const userLevel = tierLevel[plan] ?? 0;

      const frameworks = await prisma.regulatoryFramework.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { slug: true, name: true, category: true, description: true, tier: true },
      });

      return frameworks.map((fw) => ({
        slug: fw.slug,
        name: fw.name,
        category: fw.category,
        description: fw.description,
        tier: fw.tier,
        locked: userLevel < (frameworkTierLevel[fw.tier] ?? 1),
      }));
    }),

  /**
   * Run a full AI+RAG gap analysis on an uploaded policy document.
   *
   * @protected
   * @rate-limited
   */
  runGapAnalysis: protectedProcedure
    .use(rateLimited('gapAnalysis', 5))
    .use(withPlanContext)
    .use(requirePlanFeature('gapAnalysis'))
    .use(checkUsageLimit(BillingMetric.GAP_ANALYSES, { deferIncrement: true }))
    .input(
      z.object({
        fileName: z.string().min(1).max(255),
        fileType: z.enum(['pdf', 'docx', 'doc', 'txt']),
        fileContent: z.string().min(1).max(GAP_ANALYSIS_MAX_BASE64_CHARS),
        regulatoryFrameworks: z.array(z.string()).min(1).max(10),
        analysisDepth: z.enum(['quick', 'standard', 'deep']).default('standard'),
        focusAreas: z.array(z.string()).max(10).optional(),
        organizationId: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        // RBAC: Regulators cannot run gap analyses on client documents
        if (ctx.user!.role === 'REGULATOR') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Regulators cannot run gap analyses on uploaded documents',
          });
        }

        // Per-tier file size enforcement
        const decodedBytes = Math.ceil(input.fileContent.length * 0.75);
        const gapLimits = GAP_ANALYSIS_UPLOAD_LIMITS[ctx.plan ?? SubscriptionPlan.REGULATOR];
        if (gapLimits.maxFileSizeMB === 0) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Gap analysis file uploads are not available on your current plan.',
          });
        }
        const maxGapBytes = gapLimits.maxFileSizeMB * 1024 * 1024;
        if (decodedBytes > maxGapBytes) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `File exceeds the ${gapLimits.maxFileSizeMB} MB limit for your plan.`,
          });
        }

        // Validate framework slugs and enforce tier access
        const plan = ctx.plan ?? SubscriptionPlan.REGULATOR;
        const frameworkTierLevel: Record<string, number> = { STARTUP: 1, BUSINESS: 2, ENTERPRISE: 3 };
        const tierLevel: Record<string, number> = { REGULATOR: 3, STARTUP: 1, BUSINESS: 2, ENTERPRISE: 3 };
        const userLevel = tierLevel[plan] ?? 0;

        const dbFrameworks = await prisma.regulatoryFramework.findMany({
          where: { slug: { in: input.regulatoryFrameworks }, isActive: true },
          select: { slug: true, name: true, tier: true },
        });

        const foundSlugs = new Set(dbFrameworks.map((f) => f.slug));
        const invalidSlugs = input.regulatoryFrameworks.filter((s) => !foundSlugs.has(s));
        if (invalidSlugs.length > 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Invalid framework slug(s): ${invalidSlugs.join(', ')}`,
          });
        }

        const lockedFrameworks = dbFrameworks.filter(
          (f) => userLevel < (frameworkTierLevel[f.tier] ?? 1)
        );
        if (lockedFrameworks.length > 0) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `Your plan does not include access to: ${lockedFrameworks.map((f) => f.name).join(', ')}. Please upgrade.`,
          });
        }

        // Idempotency: deduplicate concurrent/retry submissions of the same file
        const orgId = input.organizationId ?? ctx.user!.organizationId ?? ctx.user!.id;
        const fileHash = createHash('sha256').update(input.fileContent).digest('hex');
        const dedupKey = `sheriabot:gapanalysis:dedup:${orgId}:${fileHash}`;

        const existing = await redis.get<string>(dedupKey);
        if (existing) {
          const existingAnalysis = await prisma.gapAnalysis.findUnique({ where: { id: existing } });
          if (existingAnalysis) {
            logger.info({ type: 'gap_analysis_dedup_hit', userId: ctx.user!.id, analysisId: existing });
            return existingAnalysis;
          }
        }

        logger.info({
          type: 'gap_analysis_request',
          userId: ctx.user!.id,
          fileName: input.fileName,
          frameworks: input.regulatoryFrameworks,
          depth: input.analysisDepth,
        });

        const frameworkNames = dbFrameworks.map((f) => f.name);

        const result = await complianceModule.runGapAnalysis(ctx.user!.id, {
          fileName: input.fileName,
          fileType: input.fileType,
          fileContent: input.fileContent,
          regulatoryFrameworks: frameworkNames,
          analysisDepth: input.analysisDepth,
          focusAreas: input.focusAreas,
          organizationId: input.organizationId ?? ctx.user!.organizationId ?? undefined,
          ipAddress: ctx.req.ip,
          userAgent: ctx.req.headers['user-agent'] as string | undefined,
          trialUserId: ctx.plan === 'FREE_TRIAL' ? ctx.user!.id : undefined,
        });

        await redis.set(dedupKey, result.id, { ex: 900 });
        await ctx.incrementUsage?.();

        logger.info({ type: 'gap_analysis_request_success', userId: ctx.user!.id, analysisId: result.id, status: result.status });
        return result;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to run gap analysis';
        logger.error({ type: 'gap_analysis_request_error', userId: ctx.user!.id, error: msg });
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg, cause: error });
      }
    }),

  /**
   * List all gap analyses for the current user.
   *
   * @protected
   */
  getGapAnalyses: protectedProcedure.query(async ({ ctx }) => {
    try {
      const analyses = await complianceModule.getUserGapAnalyses(ctx.user!.id);
      logger.info({ type: 'gap_analysis_list_retrieved', userId: ctx.user!.id, count: analyses.length });
      return analyses;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to retrieve gap analyses';
      logger.error({ type: 'gap_analysis_list_error', userId: ctx.user!.id, error: msg });
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg, cause: error });
    }
  }),

  /**
   * Get a specific gap analysis result by ID.
   *
   * @protected
   */
  getGapAnalysisResult: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      try {
        const result = await complianceModule.getGapAnalysisResult(ctx.user!.id, input.id, {
          ipAddress: ctx.req.ip,
          userAgent: ctx.req.headers['user-agent'] as string | undefined,
        });
        logger.info({ type: 'gap_analysis_result_retrieved', userId: ctx.user!.id, analysisId: input.id });
        return result;
      } catch (error: unknown) {
        if (error instanceof NotFoundError) throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
        if (error instanceof ForbiddenError) throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to retrieve gap analysis', cause: error });
      }
    }),

  /**
   * Returns the caller's per-tier gap analysis file size limit.
   */
  getGapAnalysisLimits: protectedProcedure
    .use(withPlanContext)
    .query(({ ctx }) => {
      const limits = GAP_ANALYSIS_UPLOAD_LIMITS[ctx.plan];
      return { maxFileSizeMB: limits.maxFileSizeMB };
    }),

  /**
   * Delete a gap analysis record and its R2 file.
   *
   * @protected
   */
  deleteGapAnalysis: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      try {
        await complianceModule.deleteGapAnalysis(ctx.user!.id, input.id, {
          ipAddress: ctx.req.ip,
          userAgent: ctx.req.headers['user-agent'] as string | undefined,
        });
        logger.info({ type: 'gap_analysis_deleted', userId: ctx.user!.id, analysisId: input.id });
        return { success: true };
      } catch (error: unknown) {
        logger.error({
          type: 'gap_analysis_delete_error',
          userId: ctx.user!.id,
          analysisId: input.id,
          error: (error as Error).message,
        });
        if (error instanceof NotFoundError) throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
        if (error instanceof ForbiddenError) throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to delete gap analysis', cause: error });
      }
    }),
});
