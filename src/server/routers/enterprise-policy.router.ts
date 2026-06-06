import { TRPCError } from '@trpc/server';
import { createHash } from 'crypto';
import { router, orgMemberProcedure } from '../trpc/trpc';
import { BillingMetric } from '@prisma/client';
import { storageConfig } from '@/config/storage.config';
import { generatedPolicyExportService } from '@/services/generated-policy-export.service';
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
  updateSectionStatusSchema,
  getVersionHistorySchema,
  getStatusSchema,
  deletePolicySchema,
  exportGeneratedPolicySchema,
} from '../schemas/enterprise-policy.schema';

type PolicySection = {
  id: string;
  title?: string;
  content?: unknown;
  contentMarkdown?: string;
  status?: string;
  wordCount?: number;
  editedAt?: string;
  editedByUserId?: string;
};

const EDITABLE_POLICY_STATUSES = new Set(['COMPLETED']);
const EXPORTABLE_POLICY_STATUSES = new Set(['COMPLETED']);

function getPolicySections(value: unknown): PolicySection[] {
  return Array.isArray(value) ? (value as PolicySection[]) : [];
}

function nextSectionVersion(existing: Array<{ version: number }>): number {
  const latest = existing.reduce((max, row) => Math.max(max, row.version), 0);
  return latest + 1;
}

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
          organizationId: true,
          sections: true,
          status: true,
          deletedAt: true,
        },
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
          message: 'You do not have access to this policy.',
        });
      }

      if (!EDITABLE_POLICY_STATUSES.has(policy.status)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Policy sections can only be edited after generation is complete.',
        });
      }

      const sections = getPolicySections(policy.sections);
      const sectionIndex = sections.findIndex((s) => s.id === input.sectionId);

      if (sectionIndex === -1) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Section "${input.sectionId}" not found in this policy.`,
        });
      }

      const previousSection = sections[sectionIndex];
      const previousStatus = previousSection.status ?? 'DRAFT';
      const previousContent = previousSection.contentMarkdown ?? previousSection.content ?? null;
      const nextContent = input.contentMarkdown ?? input.content ?? null;
      const existingVersions = await prisma.generatedPolicySectionVersion.findMany({
        where: { generatedPolicyId: policy.id, sectionId: input.sectionId },
        select: { version: true },
      });
      const version = nextSectionVersion(existingVersions);
      const editedAt = new Date();

      sections[sectionIndex] = {
        ...previousSection,
        content: input.content,
        contentMarkdown: input.contentMarkdown ?? previousSection.contentMarkdown,
        status: previousStatus,
        editedAt: editedAt.toISOString(),
        editedByUserId: userId,
      };

      const [, updatedPolicy] = await prisma.$transaction([
        prisma.generatedPolicySectionVersion.create({
          data: {
            generatedPolicyId: policy.id,
            sectionId: input.sectionId,
            version,
            previousContent: previousContent === null ? undefined : previousContent as any,
            newContent: nextContent === null ? undefined : nextContent as any,
            previousStatus,
            newStatus: previousStatus,
            editedByUserId: userId,
          },
        }),
        prisma.generatedPolicy.update({
          where: { id: input.policyId },
          data: { sections },
          select: { id: true, sections: true, updatedAt: true },
        }),
      ]);

      logger.info({
        type: 'enterprise_policy_section_updated',
        policyId: input.policyId,
        sectionId: input.sectionId,
        userId,
        organizationId,
        version,
      });

      logger.info({
        type: 'enterprise_policy_section_version_created',
        policyId: input.policyId,
        sectionId: input.sectionId,
        userId,
        organizationId,
        version,
      });

      const updatedSection = getPolicySections(updatedPolicy.sections).find((section) => section.id === input.sectionId);

      return {
        success: true,
        section: updatedSection,
        version,
        updatedAt: updatedPolicy.updatedAt,
      };
    }),

  updateSectionStatus: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('policyGeneration'))
    .input(updateSectionStatusSchema)
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user!.id;
      const organizationId = ctx.orgMembership!.organizationId;

      const policy = await prisma.generatedPolicy.findUnique({
        where: { id: input.policyId },
        select: {
          id: true,
          organizationId: true,
          sections: true,
          status: true,
          deletedAt: true,
        },
      });

      if (!policy || policy.deletedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Generated policy not found.' });
      }

      if (policy.organizationId !== organizationId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this policy.' });
      }

      if (!EDITABLE_POLICY_STATUSES.has(policy.status)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Policy section status can only be updated after generation is complete.',
        });
      }

      const sections = getPolicySections(policy.sections);
      const sectionIndex = sections.findIndex((s) => s.id === input.sectionId);

      if (sectionIndex === -1) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Section "${input.sectionId}" not found in this policy.` });
      }

      const previousSection = sections[sectionIndex];
      const previousStatus = previousSection.status ?? 'DRAFT';
      const existingVersions = await prisma.generatedPolicySectionVersion.findMany({
        where: { generatedPolicyId: policy.id, sectionId: input.sectionId },
        select: { version: true },
      });
      const version = nextSectionVersion(existingVersions);
      const editedAt = new Date();

      sections[sectionIndex] = {
        ...previousSection,
        status: input.status,
        editedAt: editedAt.toISOString(),
        editedByUserId: userId,
      };

      const [, updatedPolicy] = await prisma.$transaction([
        prisma.generatedPolicySectionVersion.create({
          data: {
            generatedPolicyId: policy.id,
            sectionId: input.sectionId,
            version,
            previousContent: (previousSection.contentMarkdown ?? previousSection.content ?? undefined) as any,
            newContent: (previousSection.contentMarkdown ?? previousSection.content ?? undefined) as any,
            previousStatus,
            newStatus: input.status,
            editedByUserId: userId,
          },
        }),
        prisma.generatedPolicy.update({
          where: { id: input.policyId },
          data: { sections },
          select: { id: true, sections: true, updatedAt: true },
        }),
      ]);

      logger.info({
        type: 'enterprise_policy_section_status_changed',
        policyId: input.policyId,
        sectionId: input.sectionId,
        userId,
        organizationId,
        previousStatus,
        newStatus: input.status,
        version,
      });

      const updatedSection = getPolicySections(updatedPolicy.sections).find((section) => section.id === input.sectionId);

      return {
        success: true,
        section: updatedSection,
        version,
        updatedAt: updatedPolicy.updatedAt,
      };
    }),

  getVersionHistory: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('policyGeneration'))
    .input(getVersionHistorySchema)
    .query(async ({ input, ctx }) => {
      const organizationId = ctx.orgMembership!.organizationId;

      const policy = await prisma.generatedPolicy.findUnique({
        where: { id: input.policyId },
        select: {
          id: true,
          organizationId: true,
          sections: true,
          deletedAt: true,
        },
      });

      if (!policy || policy.deletedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Generated policy not found.' });
      }

      if (policy.organizationId !== organizationId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this policy.' });
      }

      const sectionTitles = new Map(
        getPolicySections(policy.sections).map((section) => [section.id, section.title ?? section.id]),
      );

      const rows = await prisma.generatedPolicySectionVersion.findMany({
        where: { generatedPolicyId: policy.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          sectionId: true,
          version: true,
          previousStatus: true,
          newStatus: true,
          editedByUserId: true,
          createdAt: true,
        },
      });

      const users = await prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((row) => row.editedByUserId))] } },
        select: { id: true, fullName: true, email: true },
      });
      const userNames = new Map(users.map((user) => [user.id, user.fullName || user.email]));

      return rows.map((row) => ({
        ...row,
        sectionTitle: sectionTitles.get(row.sectionId) ?? row.sectionId,
        editedByName: userNames.get(row.editedByUserId) ?? 'Unknown user',
      }));
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
        include: {
          user: { select: { fullName: true, email: true } },
          organization: { select: { name: true } },
          citations: { orderBy: { createdAt: 'asc' } },
        },
      });

      if (!policy || policy.deletedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Generated policy not found.' });
      }

      if (policy.organizationId !== organizationId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this policy.' });
      }

      if (!EXPORTABLE_POLICY_STATUSES.has(policy.status)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Policy can only be exported after generation completes.' });
      }

      if (input.format === 'PDF') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'PDF export is not available yet. Please export DOCX.',
        });
      }

      const startedAt = Date.now();
      logger.info({
        type: 'enterprise_policy_export_requested',
        policyId: policy.id,
        userId,
        organizationId,
        format: input.format,
      });

      try {
        const exportedAt = new Date();
        const sections = getPolicySections(policy.sections);
        if (!sections.length) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This policy has no generated sections to export.',
          });
        }

        const buffer = await generatedPolicyExportService.generateDocx({
          policyId: policy.id,
          title: policy.title,
          policyType: policy.policyType,
          jurisdiction: policy.jurisdiction,
          organizationName: policy.organization.name,
          version: policy.version,
          createdAt: policy.createdAt,
          completedAt: policy.completedAt,
          exportedAt,
          exportedBy: policy.user.fullName || policy.user.email,
          executiveSummary: policy.executiveSummary,
          tableOfContents: policy.tableOfContents,
          sections,
          citations: policy.citations,
          reviewNotes: policy.reviewNotes,
        });

        const dateStamp = exportedAt.toISOString().slice(0, 10).replace(/-/g, '');
        const org = generatedPolicyExportService.sanitiseFilename(policy.organization.name);
        const title = generatedPolicyExportService.sanitiseFilename(policy.title);
        const filename = `SheriaBot-${org}-${title}-v${policy.version}-${dateStamp}.docx`;
        const uploadResult = await ctx.storageService.uploadPolicyExport(buffer, filename, policy.id, userId);
        const downloadUrl = await ctx.storageService.getDownloadUrl(
          uploadResult.key,
          storageConfig.presignedUrls.expiry.download,
          false,
          filename,
        );

        await prisma.$transaction([
          prisma.generatedPolicyExportLog.create({
            data: {
              generatedPolicyId: policy.id,
              userId,
              organizationId,
              format: input.format,
              storageKey: uploadResult.key,
              filename,
              metadata: {
                title: policy.title,
                status: policy.status,
                sizeBytes: uploadResult.size,
                contentType: uploadResult.contentType,
                sectionCount: sections.length,
                citationCount: policy.citations.length,
                durationMs: Date.now() - startedAt,
              },
            },
          }),
          prisma.generatedPolicy.update({
            where: { id: policy.id },
            data: {
              lastExportedAt: exportedAt,
              lastExportFormat: input.format,
            },
          }),
        ]);

        logger.info({
          type: 'enterprise_policy_export_succeeded',
          policyId: policy.id,
          userId,
          organizationId,
          format: input.format,
          storageKey: uploadResult.key,
          durationMs: Date.now() - startedAt,
        });

        return {
          downloadUrl,
          filename,
          expiresAt: new Date(Date.now() + storageConfig.presignedUrls.expiry.download * 1000).toISOString(),
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;

        logger.error({
          type: 'enterprise_policy_export_failed',
          policyId: policy.id,
          userId,
          organizationId,
          format: input.format,
          error: error instanceof Error ? error.message : 'Unknown export error',
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to generate policy export. Please try again.',
        });
      }
    }),
});
