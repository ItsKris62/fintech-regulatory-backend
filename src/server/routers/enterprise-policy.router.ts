import { TRPCError } from '@trpc/server';
import { createHash } from 'crypto';
import { router, orgMemberProcedure } from '../trpc/trpc';
import { BillingMetric } from '@prisma/client';
import {
  rateLimited,
  withPlanContext,
  requirePlanFeature,
  checkUsageLimit,
} from '../trpc/middleware';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { aiJobRunner } from '@/modules/ai-jobs/ai-job-runner';
import {
  createDraftSchema,
  getPolicySchema,
  listPoliciesSchema,
  updateSectionContentSchema,
  getStatusSchema,
  deletePolicySchema,
  exportGeneratedPolicySchema,
} from '../schemas/enterprise-policy.schema';

// =============================================================================
// Enterprise AI Policy Generator — tRPC Router
// =============================================================================
// Phase 1: Skeleton endpoints only. The actual LangChain/RAG generation
// pipeline will be implemented in Phase 2.
// =============================================================================

export const enterprisePolicyRouter = router({
  // ---------------------------------------------------------------------------
  // CREATE DRAFT
  // ---------------------------------------------------------------------------
  /**
   * Creates a new GeneratedPolicy record in INITIALIZING state.
   *
   * Middleware chain:
   * 1. protectedProcedure  → ensures authenticated user
   * 2. rateLimited         → max 3 policy generations per 15-min window
   * 3. withPlanContext      → resolves ctx.plan to the effective subscription plan
   * 4. requirePlanFeature   → ENTERPRISE-only gate (policyGeneration)
   * 5. checkUsageLimit      → Redis monthly counter (deferred increment)
   *
   * @returns { policyId, status } — the frontend starts polling getStatus
   */
  createDraft: orgMemberProcedure
    .use(rateLimited('enterprisePolicyGeneration', 3))
    .use(withPlanContext)
    .use(requirePlanFeature('policyGeneration'))
    .use(checkUsageLimit(BillingMetric.POLICY_GENERATIONS, { deferIncrement: true }))
    .input(createDraftSchema)
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user!.id;
      const organizationId = ctx.orgMembership!.organizationId;

      // If linking to a gap analysis, verify ownership
      if (input.sourceGapAnalysisId) {
        const gap = await prisma.gapAnalysis.findUnique({
          where: { id: input.sourceGapAnalysisId },
          select: { organizationId: true },
        });

        if (!gap || gap.organizationId !== organizationId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Source gap analysis not found or does not belong to your organization.',
          });
        }
      }

      // Create the GeneratedPolicy record in INITIALIZING state
      const policy = await prisma.generatedPolicy.create({
        data: {
          userId,
          organizationId,
          policyType: input.policyType,
          title: input.title,
          description: input.description,
          targetAudience: input.targetAudience,
          organizationType: input.organizationType,
          regulatoryFrameworks: input.regulatoryFrameworks,
          jurisdiction: input.jurisdiction,
          sourceGapAnalysisId: input.sourceGapAnalysisId,
          sourceGapId: input.sourceGapId,
          status: 'INITIALIZING',
          progress: 0,
        },
        select: {
          id: true,
          status: true,
          title: true,
          policyType: true,
          createdAt: true,
        },
      });

      const idempotencyKey = createHash('sha256')
        .update([
          'generated-policy',
          policy.id,
          organizationId,
          userId,
          input.policyType,
          input.title,
          input.sourceGapAnalysisId ?? '',
          input.sourceGapId ?? '',
        ].join(':'))
        .digest('hex');

      const job = await aiJobRunner.enqueue({
        type: 'GENERATED_POLICY_PIPELINE',
        idempotencyKey,
        targetEntityType: 'GeneratedPolicy',
        targetEntityId: policy.id,
        userId,
        organizationId,
        payload: input,
        maxAttempts: 3,
        priority: 10,
      });

      logger.info({
        type: 'enterprise_policy_draft_created',
        policyId: policy.id,
        jobId: job.id,
        userId,
        organizationId,
        policyType: input.policyType,
        hasSourceGap: !!input.sourceGapAnalysisId,
      });

      // Commit the deferred usage increment
      if (ctx.incrementUsage) {
        await ctx.incrementUsage();
      }

      return {
        policyId: policy.id,
        status: policy.status,
        title: policy.title,
        policyType: policy.policyType,
        jobId: job.id,
        createdAt: policy.createdAt,
      };
    }),

  // ---------------------------------------------------------------------------
  // GET STATUS (Polling endpoint)
  // ---------------------------------------------------------------------------
  /**
   * Returns the current pipeline status and progress percentage.
   * Frontend polls this with refetchInterval: 2000 while !isComplete && !isFailed.
   */
  getStatus: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('policyGeneration'))
    .input(getStatusSchema)
    .query(async ({ input, ctx }) => {
      const policy = await prisma.generatedPolicy.findUnique({
        where: { id: input.policyId },
        select: {
          id: true,
          userId: true,
          organizationId: true,
          status: true,
          progress: true,
          title: true,
          errorMessage: true,
          generationMetadata: true,
          updatedAt: true,
        },
      });

      if (!policy) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Generated policy not found.',
        });
      }

      if (policy.organizationId !== ctx.orgMembership!.organizationId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have access to this policy.',
        });
      }

      const job = await prisma.aiJob.findFirst({
        where: { targetEntityType: 'GeneratedPolicy', targetEntityId: policy.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          attempts: true,
          maxAttempts: true,
          lastError: true,
          updatedAt: true,
          events: {
            orderBy: { createdAt: 'desc' },
            take: 5,
            select: { type: true, message: true, progress: true, createdAt: true },
          },
        },
      });

      const stageLabels: Record<string, string> = {
        INITIALIZING: 'Initializing',
        OUTLINING: 'Generating Table of Contents',
        DRAFTING: 'Writing Policy Sections',
        REVIEWING: 'Reviewing & Verifying Citations',
        COMPLETED: 'Complete',
        FAILED: 'Failed',
        ARCHIVED: 'Archived',
      };

      return {
        policyId: policy.id,
        job,
        jobId: (policy.generationMetadata as Record<string, unknown> | null)?.jobId ?? null,
        status: policy.status,
        progress: policy.progress,
        title: policy.title,
        currentStage: stageLabels[policy.status] ?? policy.status,
        isComplete: policy.status === 'COMPLETED',
        isFailed: policy.status === 'FAILED',
        errorMessage: policy.errorMessage,
        updatedAt: policy.updatedAt,
      };
    }),

  // ---------------------------------------------------------------------------
  // GET POLICY (full detail)
  // ---------------------------------------------------------------------------
  /**
   * Fetches a single generated policy with all content, sections,
   * citations, and metadata. Used when the editor is loaded.
   */
  getPolicy: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('policyGeneration'))
    .input(getPolicySchema)
    .query(async ({ input, ctx }) => {
      const organizationId = ctx.orgMembership!.organizationId;

      const policy = await prisma.generatedPolicy.findUnique({
        where: { id: input.policyId },
        include: {
          citations: {
            orderBy: { createdAt: 'asc' },
          },
          sourceGapAnalysis: {
            select: {
              id: true,
              documentName: true,
              regulatoryFrameworks: true,
              overallScore: true,
            },
          },
        },
      });

      if (!policy || policy.deletedAt) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Generated policy not found.',
        });
      }

      // Verify organization ownership.
      if (policy.organizationId !== organizationId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have access to this policy.',
        });
      }

      return policy;
    }),

  // ---------------------------------------------------------------------------
  // LIST POLICIES
  // ---------------------------------------------------------------------------
  /**
   * Returns a paginated list of generated policies for the current user's
   * organization.
   */
  listPolicies: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('policyGeneration'))
    .input(listPoliciesSchema)
    .query(async ({ input, ctx }) => {
      const organizationId = ctx.orgMembership!.organizationId;

      const where: any = {
        deletedAt: null,
        organizationId,
      };

      if (input.status) {
        where.status = input.status;
      }
      if (input.policyType) {
        where.policyType = input.policyType;
      }

      const policies = await prisma.generatedPolicy.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: input.limit + 1, // fetch one extra for cursor pagination
        ...(input.cursor
          ? {
              cursor: { id: input.cursor },
              skip: 1,
            }
          : {}),
        select: {
          id: true,
          policyType: true,
          title: true,
          description: true,
          status: true,
          progress: true,
          regulatoryFrameworks: true,
          jurisdiction: true,
          version: true,
          lastExportedAt: true,
          lastExportFormat: true,
          sourceGapAnalysisId: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
        },
      });

      let nextCursor: string | undefined;
      if (policies.length > input.limit) {
        const nextItem = policies.pop()!;
        nextCursor = nextItem.id;
      }

      return {
        items: policies,
        nextCursor,
        totalEstimate: await prisma.generatedPolicy.count({ where }),
      };
    }),

  // ---------------------------------------------------------------------------
  // UPDATE SECTION CONTENT
  // ---------------------------------------------------------------------------
  /**
   * Saves updated TipTap JSON content for a single policy section.
   * Called by the editor on auto-save (3-second debounce) or manual save.
   */
  updateSectionContent: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('policyGeneration'))
    .input(updateSectionContentSchema)
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user!.id;
      const organizationId = ctx.orgMembership!.organizationId;

      const policy = await prisma.generatedPolicy.findUnique({
        where: { id: input.policyId },
        select: {
          id: true,
          userId: true,
          organizationId: true,
          sections: true,
          status: true,
        },
      });

      if (!policy || policy.organizationId !== organizationId) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Generated policy not found.',
        });
      }

      if (policy.status !== 'COMPLETED') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Policy sections can only be edited after generation is complete.',
        });
      }

      // Parse existing sections, find the target section, update it
      const sections = (policy.sections as any[]) ?? [];
      const sectionIndex = sections.findIndex((s: any) => s.id === input.sectionId);

      if (sectionIndex === -1) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Section "${input.sectionId}" not found in this policy.`,
        });
      }

      // Update the section content
      sections[sectionIndex] = {
        ...sections[sectionIndex],
        content: input.content,
        contentMarkdown: input.contentMarkdown ?? sections[sectionIndex].contentMarkdown,
        status: 'edited',
        editedAt: new Date().toISOString(),
      };

      await prisma.generatedPolicy.update({
        where: { id: input.policyId },
        data: {
          sections: sections,
        },
      });

      logger.info({
        type: 'enterprise_policy_section_updated',
        policyId: input.policyId,
        sectionId: input.sectionId,
        userId,
      });

      return {
        success: true,
        sectionId: input.sectionId,
        updatedAt: new Date().toISOString(),
      };
    }),

  // ---------------------------------------------------------------------------
  // DELETE POLICY (soft delete)
  // ---------------------------------------------------------------------------
  /**
   * Soft-deletes a generated policy by setting deletedAt.
   */
  deletePolicy: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('policyGeneration'))
    .input(deletePolicySchema)
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user!.id;
      const organizationId = ctx.orgMembership!.organizationId;

      const policy = await prisma.generatedPolicy.findUnique({
        where: { id: input.policyId },
        select: { id: true, userId: true, organizationId: true, deletedAt: true },
      });

      if (!policy || policy.deletedAt) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Generated policy not found.',
        });
      }

      if (policy.organizationId !== organizationId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have permission to delete this policy.',
        });
      }

      await prisma.generatedPolicy.update({
        where: { id: input.policyId },
        data: {
          deletedAt: new Date(),
          status: 'ARCHIVED',
        },
      });

      logger.info({
        type: 'enterprise_policy_deleted',
        policyId: input.policyId,
        userId,
      });

      return { success: true };
    }),

  exportPolicy: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('policyGeneration'))
    .input(exportGeneratedPolicySchema)
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user!.id;
      const organizationId = ctx.orgMembership!.organizationId;

      const policy = await prisma.generatedPolicy.findUnique({
        where: { id: input.policyId },
        select: {
          id: true,
          title: true,
          userId: true,
          organizationId: true,
          deletedAt: true,
          status: true,
        },
      });

      if (!policy || policy.deletedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Generated policy not found.' });
      }

      if (policy.organizationId !== organizationId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this policy.' });
      }

      if (policy.status !== 'COMPLETED') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Policy can only be exported after generation completes.' });
      }

      const timestamp = Date.now();
      const extension = input.format.toLowerCase();
      const filename = `generated-policy-${policy.id}-${timestamp}.${extension}`;
      const storageKey = `policy-exports/${filename}`;
      const uploadResult = await ctx.storageService.getUploadUrl(storageKey, 'application/octet-stream');

      await prisma.$transaction([
        prisma.generatedPolicyExportLog.create({
          data: {
            generatedPolicyId: policy.id,
            userId,
            organizationId,
            format: input.format,
            storageKey,
            filename,
            metadata: {
              title: policy.title,
              status: policy.status,
              placeholderExport: true,
            },
          },
        }),
        prisma.generatedPolicy.update({
          where: { id: policy.id },
          data: {
            lastExportedAt: new Date(),
            lastExportFormat: input.format,
          },
        }),
      ]);

      logger.info({
        type: 'enterprise_policy_export_logged',
        policyId: policy.id,
        userId,
        organizationId,
        format: input.format,
      });

      return {
        downloadUrl: uploadResult.url,
        filename,
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      };
    }),
});
