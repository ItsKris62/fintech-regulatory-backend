import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { createHash } from 'crypto';
import { router, protectedProcedure, orgMemberProcedure } from '../trpc/trpc';
import { BillingMetric, SubscriptionPlan } from '@prisma/client';
import { rateLimited, withPlanContext, requirePlanFeature, resolveUsageLimit } from '../trpc/middleware';
import { complianceModule } from '@/modules/compliance';
import { logger } from '@/utils/logger';
import { NotFoundError, ForbiddenError } from '@/utils/error';
import { redis } from '@/lib/redis/client';
import { prisma } from '@/lib/prisma/client';
import { GAP_ANALYSIS_UPLOAD_LIMITS, GAP_ANALYSIS_MAX_BASE64_CHARS } from '@/config/upload-limits.config';
import { validateAuthorizedBenchmarkDocumentIds } from '../services/benchmark-document.service';
import { canAccessFrameworkTier } from '../services/framework-access.service';
import {
  JurisdictionContractError,
  type JurisdictionContext,
} from '@/types/jurisdiction';
import {
  JurisdictionAuthorizationError,
  resolveJurisdictionEntitlement,
  toTrpcJurisdictionAuthorizationError,
} from '@/modules/jurisdiction/jurisdiction-entitlements';

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
    .input(z.void())
    .query(async ({ ctx }) => {
      const plan = ctx.plan ?? SubscriptionPlan.REGULATOR;

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
        locked: !canAccessFrameworkTier(plan, fw.tier),
      }));
    }),

  /**
   * Run a full AI+RAG gap analysis on an uploaded policy document.
   *
   * Security: organizationId is derived exclusively from ctx.orgMembership
   * (set by requireOrgMembership via orgMemberProcedure) and never from the
   * request body, closing the IDOR that allowed cross-tenant org attribution.
   * Dedup key uses v2 namespace keyed on userId to prevent cross-tenant cache
   * poisoning with the same file hash.
   *
   * @protected @org-member @rate-limited
   */
  runGapAnalysis: orgMemberProcedure
    .use(rateLimited('gapAnalysis', 5))
    .use(withPlanContext)
    .use(requirePlanFeature('gapAnalysis'))
    .use(requirePlanFeature('benchmarkDocuments'))
    .input(
      z.object({
        fileName: z.string().min(1).max(255),
        fileType: z.enum(['pdf', 'docx', 'doc', 'txt']),
        fileContent: z.string().min(1).max(GAP_ANALYSIS_MAX_BASE64_CHARS),
        regulatoryFrameworks: z.array(z.string()).min(1).max(10),
        benchmarkDocumentIds: z.array(z.string().min(1)).max(10).optional(),
        analysisDepth: z.enum(['quick', 'standard', 'deep']).default('standard'),
        focusAreas: z.array(z.string()).max(10).optional(),
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

        if (ctx.user?.id) {
          const { section34RestrictionService } = await import('@/modules/user/restriction.service');
          const check = await section34RestrictionService.isProcessingPermitted(ctx.user.id, 'GAP_ANALYSIS');
          if (!check.permitted) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: check.reason ?? 'Gap analysis restricted pursuant to DPA Section 34',
            });
          }
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
        const dbFrameworks = await prisma.regulatoryFramework.findMany({
          where: { slug: { in: input.regulatoryFrameworks }, isActive: true },
          select: { id: true, slug: true, name: true, category: true, tier: true, sortOrder: true },
        });

        const foundSlugs = new Set(dbFrameworks.map((f) => f.slug));
        const invalidSlugs = input.regulatoryFrameworks.filter((s) => !foundSlugs.has(s));
        if (invalidSlugs.length > 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Invalid framework slug(s): ${invalidSlugs.join(', ')}`,
          });
        }
        const frameworksBySlug = new Map(dbFrameworks.map((framework) => [framework.slug, framework]));
        const orderedFrameworks = input.regulatoryFrameworks.map((slug) => frameworksBySlug.get(slug)!);

        const lockedFrameworks = orderedFrameworks.filter((f) => !canAccessFrameworkTier(plan, f.tier));
        if (lockedFrameworks.length > 0) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `Your plan does not include access to: ${lockedFrameworks.map((f) => f.name).join(', ')}. Please upgrade.`,
          });
        }

        // orgId is always session-derived -- never client-supplied (IDOR closed)
        const orgId   = ctx.orgMembership!.organizationId;
        const userId  = ctx.user!.id;
        let jurisdictionContext: JurisdictionContext;
        try {
          const entitlement = await resolveJurisdictionEntitlement({
            prisma: ctx.prisma as any,
            organizationId: orgId,
            effectivePlan: ctx.plan ?? 'REGULATOR',
            requestedJurisdictions: undefined,
            source: 'ORGANIZATION_HOME',
            audit: {
              userId,
              route: 'trpc.gapAnalysis.runGapAnalysis',
            },
          });
          jurisdictionContext = entitlement.jurisdictionContext;
        } catch (error) {
          if (error instanceof JurisdictionContractError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
          }
          if (error instanceof JurisdictionAuthorizationError) throw toTrpcJurisdictionAuthorizationError(error);
          throw error;
        }
        const usagePatch = await resolveUsageLimit(ctx, BillingMetric.GAP_ANALYSES, { deferIncrement: true });
        const benchmarkDocumentIds = [...new Set(input.benchmarkDocumentIds ?? [])];

        // Idempotency: v2 key scoped to submitting user, preventing cross-tenant
        // cache poisoning via identical file hash submitted with a different orgId.
        const fileHash = createHash('sha256')
          .update(input.fileContent)
          .update(JSON.stringify({
            organizationId: orgId,
            jurisdictionCode: jurisdictionContext.mode === 'SINGLE' ? jurisdictionContext.primaryJurisdiction : null,
            frameworks: [...input.regulatoryFrameworks].sort(),
            benchmarkDocumentIds: [...benchmarkDocumentIds].sort(),
            analysisDepth: input.analysisDepth,
            focusAreas: [...(input.focusAreas ?? [])].sort(),
          }))
          .digest('hex');
        const dedupKey = `sheriabot:gapanalysis:dedup:v3:${userId}:${fileHash}`;

        const existing = await redis.get<string>(dedupKey);
        if (existing) {
          const existingAnalysis = await prisma.gapAnalysis.findUnique({ where: { id: existing } });
          if (existingAnalysis) {
            logger.info({ type: 'gap_analysis_dedup_hit', userId, analysisId: existing });
            return existingAnalysis;
          }
        }

        const frameworkNames = orderedFrameworks.map((f) => f.name);
        const frameworkSlugs = orderedFrameworks.map((f) => f.slug);

        const benchmarkDocuments = await validateAuthorizedBenchmarkDocumentIds({
          prisma: ctx.prisma as any,
          userId,
          organizationId: orgId,
          benchmarkDocumentIds,
        });

        const selectedBenchmarkDocuments = benchmarkDocuments.map((doc) => ({
          id: doc.id,
          title: doc.title,
          documentType: doc.documentType,
          regulatoryBody: doc.regulatoryBody ?? doc.source,
          authorityStatus: doc.authorityStatus,
          version: doc.version,
          isGlobal: doc.isGlobal,
        }));

        logger.info({
          type:       'gap_analysis_request',
          userId,
          orgId,
          fileName:   input.fileName,
          frameworks: input.regulatoryFrameworks,
          benchmarkDocumentIds,
          depth:      input.analysisDepth,
        });

        const result = await complianceModule.runGapAnalysis(userId, {
          fileName:             input.fileName,
          fileType:             input.fileType,
          fileContent:          input.fileContent,
          regulatoryFrameworks: frameworkNames,
          regulatoryFrameworkSlugs: frameworkSlugs,
          benchmarkDocumentIds,
          benchmarkDocuments: selectedBenchmarkDocuments,
          analysisDepth:        input.analysisDepth,
          focusAreas:           input.focusAreas,
          organizationId:       orgId,
          jurisdictionContext,
          ipAddress:            ctx.req.ip,
          userAgent:            ctx.req.headers['user-agent'] as string | undefined,
          trialUserId:          ctx.plan === 'FREE_TRIAL' ? userId : undefined,
        });

        await prisma.gapAnalysisFramework.createMany({
          data: orderedFrameworks.map((framework) => ({
            gapAnalysisId: result.id,
            frameworkId: framework.id,
            slug: framework.slug,
            name: framework.name,
            category: framework.category,
            tier: framework.tier,
            sortOrder: framework.sortOrder,
          })),
          skipDuplicates: true,
        });

        await redis.set(dedupKey, result.id, { ex: 900 });
        await usagePatch.incrementUsage?.();

        logger.info({ type: 'gap_analysis_request_success', userId, analysisId: result.id, status: result.status });
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
  getGapAnalyses: protectedProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
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
    .input(z.void())
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
