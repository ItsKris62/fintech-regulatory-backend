import { TRPCError } from '@trpc/server';
import { createHash } from 'crypto';
import { z } from 'zod';
import { router, orgMemberProcedure } from '../trpc/trpc';
import { BillingMetric } from '@prisma/client';
import { rateLimited, withPlanContext, requirePlanFeature, checkUsageLimit } from '../trpc/middleware';
import {
  generatePolicySchema,
  listPoliciesSchema,
  getPolicySchema,
  updatePolicySchema,
  deletePolicySchema,
  exportPolicySchema,
  refinePolicySchema,
  verifyCitationsSchema,
} from '../schemas/policy.schema';
import { policyCache } from '@/lib/redis/cache.service';
import { logger } from '@/utils/logger';
import { aiJobRunner } from '@/modules/ai-jobs/ai-job-runner';

/**
 * Policy Router
 *
 * Handles policy CRUD operations and AI-powered policy generation.
 * Includes export, refinement, and citation verification features.
 */
export const policyRouter = router({
  /**
   * List policies with pagination and filters
   *
   * @protected
   */
  list: orgMemberProcedure
    .input(listPoliciesSchema)
    .query(async ({ input, ctx }) => {
      try {
        const { page, limit, status, regulatoryArea: _regulatoryArea, search } = input;
        const skip = (page - 1) * limit;

        // Note: deletedAt filter is also applied by Prisma soft-delete middleware.
        // Keeping explicit filter as defense-in-depth.
        const where: import('@prisma/client').Prisma.PolicyWhereInput = {
          deletedAt: null,
        };

        if (ctx.user!.role === 'ADMIN') {
          // Admin sees all policies globally  -  audit log required
          logger.info({
            type: 'admin_policy_list_accessed',
            adminUserId: ctx.user!.id,
          });
        } else {
          // Org-scoped: show all policies belonging to the user's organization
          where.organizationId = ctx.orgMembership!.organizationId;
        }

        if (status) {
          where.status = status;
        }

        if (search) {
          where.OR = [
            { title: { contains: search, mode: 'insensitive' } },
            { scenario: { contains: search, mode: 'insensitive' } },
          ];
        }

        const [policies, total] = await Promise.all([
          ctx.prisma.policy.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              title: true,
              scenario: true,
              status: true,
              regulatoryAreas: true,
              createdAt: true,
              updatedAt: true,
              user: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                },
              },
            },
          }),
          ctx.prisma.policy.count({ where }),
        ]);

        return {
          policies,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
          },
        };
      } catch (error: any) {
        logger.error({
          type: 'policy_list_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to list policies',
          cause: error,
        });
      }
    }),

  /**
   * Get policy by ID with citations
   *
   * @protected
   */
  get: orgMemberProcedure
    .input(getPolicySchema)
    .query(async ({ input, ctx }) => {
      try {
        // Try cache first
        const cached = await policyCache.get(input.id);
        if (cached) {
          return cached;
        }

        const policy = await ctx.prisma.policy.findUnique({
          where: { id: input.id },
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                email: true,
              },
            },
            citations: {
              orderBy: { createdAt: 'asc' },
            },
          },
        });

        if (!policy || policy.deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Policy not found',
          });
        }

        // Check access  -  org-scoped with userId fallback for legacy policies
        if (ctx.user!.role !== 'ADMIN') {
          const hasAccess = policy.organizationId
            ? policy.organizationId === ctx.orgMembership!.organizationId
            : policy.userId === ctx.user!.id;

          if (!hasAccess) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Access denied to this policy',
            });
          }
        }

        // Cache
        await policyCache.set(input.id, policy);

        return policy;
      } catch (error: any) {
        logger.error({
          type: 'policy_get_error',
          userId: ctx.user!.id,
          policyId: input.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get policy',
          cause: error,
        });
      }
    }),

  /**
   * Generate policy with AI
   *
   * @protected
   * @rate-limited
   */
  generate: orgMemberProcedure
    .use(rateLimited('policyGeneration'))
    .use(withPlanContext)
    .use(requirePlanFeature('policyGeneration'))
    // deferIncrement: true  -  usage counter is committed only after the DB record is
    // created, preventing lost credits if the policy.create itself fails.
    .use(checkUsageLimit(BillingMetric.POLICY_GENERATIONS, { deferIncrement: true }))
    .input(generatePolicySchema)
    .mutation(async ({ input, ctx }) => {
      const startTime = Date.now();

      try {
        logger.info({
          type: 'policy_generation_start',
          userId: ctx.user!.id,
          organizationType: input.organizationType,
          regulatoryAreas: input.regulatoryAreas,
        });

        // Create policy record  -  cast to any since schema differs
        const policy = await (ctx.prisma.policy.create as any)({
          data: {
            title: input.title || `Policy for ${input.organizationType}`,
            scenario: input.scenario,
            organizationType: input.organizationType,
            regulatoryAreas: input.regulatoryAreas,
            specificRequirements: input.specificRequirements,
            targetAudience: input.targetAudience,
            status: 'GENERATING',
            userId: ctx.user!.id,
            organizationId: ctx.orgMembership!.organizationId,
            urgency: 'medium',
            stakeholders: [],
          },
        });

        // Commit usage counter now that the DB record exists.
        // Consumed at queue time (not AI completion) to prevent free retries on AI failure.
        await ctx.incrementUsage?.();

        const idempotencyKey = createHash('sha256')
          .update(['policy-generation', policy.id, ctx.user!.id].join(':'))
          .digest('hex');

        const job = await aiJobRunner.enqueue({
          type: 'POLICY_GENERATION',
          idempotencyKey,
          targetEntityType: 'Policy',
          targetEntityId: policy.id,
          userId: ctx.user!.id,
          organizationId: ctx.orgMembership!.organizationId,
          payload: {
            scenario: input.scenario,
            organizationType: input.organizationType,
            regulatoryAreas: input.regulatoryAreas,
            specificRequirements: input.specificRequirements,
            targetAudience: input.targetAudience,
            requestedByEmail: ctx.user!.email,
            queuedAt: new Date(startTime).toISOString(),
          },
          maxAttempts: 3,
          priority: 5,
        });

        // Return immediately with policy ID
        return {
          policyId: policy.id,
          jobId: job.id,
          status: 'GENERATING',
          message: 'Policy generation started. You will be notified when complete.',
        };
      } catch (error: any) {
        logger.error({
          type: 'policy_generation_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to start policy generation',
          cause: error,
        });
      }
    }),

  /**
   * Update policy
   *
   * @protected
   */
  update: orgMemberProcedure
    .input(updatePolicySchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const { id, ...data } = input;

        // Check access
        const existingPolicy = await ctx.prisma.policy.findUnique({
          where: { id },
        });

        if (!existingPolicy || existingPolicy.deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Policy not found',
          });
        }

        if (ctx.user!.role !== 'ADMIN') {
          const hasAccess = existingPolicy.organizationId
            ? existingPolicy.organizationId === ctx.orgMembership!.organizationId
            : existingPolicy.userId === ctx.user!.id;

          if (!hasAccess) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Access denied to this policy',
            });
          }
        }

        const policy = await (ctx.prisma.policy.update as any)({
          where: { id },
          data: {
            ...data,
            updatedAt: new Date(),
          },
        });

        // Clear cache
        await policyCache.delete(id);

        logger.info({
          type: 'policy_updated',
          userId: ctx.user!.id,
          policyId: id,
          fields: Object.keys(data),
        });

        return policy;
      } catch (error: any) {
        logger.error({
          type: 'policy_update_error',
          userId: ctx.user!.id,
          policyId: input.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update policy',
          cause: error,
        });
      }
    }),

  /**
   * Delete policy (soft delete)
   *
   * @protected
   */
  delete: orgMemberProcedure
    .input(deletePolicySchema)
    .mutation(async ({ input, ctx }) => {
      try {
        // Check access
        const policy = await ctx.prisma.policy.findUnique({
          where: { id: input.id },
        });

        if (!policy || policy.deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Policy not found',
          });
        }

        if (ctx.user!.role !== 'ADMIN') {
          const hasAccess = policy.organizationId
            ? policy.organizationId === ctx.orgMembership!.organizationId
            : policy.userId === ctx.user!.id;

          if (!hasAccess) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Access denied to this policy',
            });
          }
        }

        await ctx.prisma.policy.update({
          where: { id: input.id },
          data: { deletedAt: new Date() },
        });

        // Clear cache
        await policyCache.delete(input.id);

        logger.info({
          type: 'policy_deleted',
          userId: ctx.user!.id,
          policyId: input.id,
        });

        return {
          success: true,
          message: 'Policy deleted successfully',
        };
      } catch (error: any) {
        logger.error({
          type: 'policy_delete_error',
          userId: ctx.user!.id,
          policyId: input.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete policy',
          cause: error,
        });
      }
    }),

  /**
   * Export policy to PDF/DOCX
   *
   * @protected
   */
  export: orgMemberProcedure
    .input(exportPolicySchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const policy = await ctx.prisma.policy.findUnique({
          where: { id: input.id },
          include: { citations: true },
        });

        if (!policy || policy.deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Policy not found',
          });
        }

        // Check access
        if (ctx.user!.role !== 'ADMIN') {
          const hasAccess = policy.organizationId
            ? policy.organizationId === ctx.orgMembership!.organizationId
            : policy.userId === ctx.user!.id;

          if (!hasAccess) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Access denied to this policy',
            });
          }
        }

        // Generate filename
        const timestamp = Date.now();
        const filename = `policy-${input.id}-${timestamp}.${input.format.toLowerCase()}`;
        const key = `policy-exports/${filename}`;

        // TODO: Implement actual PDF/DOCX generation
        // For now, return a placeholder URL
        const uploadResult = await ctx.storageService.getUploadUrl(key, 'application/octet-stream');

        logger.info({
          type: 'policy_exported',
          userId: ctx.user!.id,
          policyId: input.id,
          format: input.format,
        });

        return {
          downloadUrl: uploadResult.url,
          filename,
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(), // 1 hour
        };
      } catch (error: any) {
        logger.error({
          type: 'policy_export_error',
          userId: ctx.user!.id,
          policyId: input.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to export policy',
          cause: error,
        });
      }
    }),

  /**
   * Refine policy with AI
   *
   * @protected
   * @rate-limited
   */
  refine: orgMemberProcedure
    .use(rateLimited('policyRefinement'))
    .input(refinePolicySchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const policy = await ctx.prisma.policy.findUnique({
          where: { id: input.id },
        });

        if (!policy || policy.deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Policy not found',
          });
        }

        // Check access
        if (ctx.user!.role !== 'ADMIN') {
          const hasAccess = policy.organizationId
            ? policy.organizationId === ctx.orgMembership!.organizationId
            : policy.userId === ctx.user!.id;

          if (!hasAccess) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Access denied to this policy',
            });
          }
        }

        // TODO: Implement AI refinement
        // const refinedContent = await ctx.aiService.refinePolicy({
        //   currentContent: (policy as any).content,
        //   refinementInstructions: input.refinementInstructions,
        // });

        logger.info({
          type: 'policy_refined',
          userId: ctx.user!.id,
          policyId: input.id,
        });

        return {
          success: true,
          message: 'Policy refinement feature coming soon',
        };
      } catch (error: any) {
        logger.error({
          type: 'policy_refine_error',
          userId: ctx.user!.id,
          policyId: input.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to refine policy',
          cause: error,
        });
      }
    }),

  /**
   * Verify policy citations with AI
   *
   * @protected
   */
  verifyCitations: orgMemberProcedure
    .input(verifyCitationsSchema)
    .query(async ({ input, ctx }) => {
      try {
        const policy = await ctx.prisma.policy.findUnique({
          where: { id: input.id },
          include: { citations: true },
        });

        if (!policy || policy.deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Policy not found',
          });
        }

        // Check access
        if (ctx.user!.role !== 'ADMIN') {
          const hasAccess = policy.organizationId
            ? policy.organizationId === ctx.orgMembership!.organizationId
            : policy.userId === ctx.user!.id;

          if (!hasAccess) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Access denied to this policy',
            });
          }
        }

        // Verify citations with AI  -  verifyCitations takes string[]
        const citationTexts = policy.citations.map((c) => c.textSnippet);
        const verificationResults = await ctx.aiService.verifyCitations(citationTexts);

        logger.info({
          type: 'policy_citations_verified',
          userId: ctx.user!.id,
          policyId: input.id,
          totalCitations: policy.citations.length,
        });

        return verificationResults;
      } catch (error: any) {
        logger.error({
          type: 'policy_verify_citations_error',
          userId: ctx.user!.id,
          policyId: input.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to verify citations',
          cause: error,
        });
      }
    }),

  /**
   * Get policy generation status (poll endpoint)
   *
   * Used by the frontend to poll status after calling `generate`.
   * Returns status + progress so the UI can show a progress bar.
   *
   * @protected
   */
  getStatus: orgMemberProcedure
    .input(z.object({ policyId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      try {
        const policy = await ctx.prisma.policy.findUnique({
          where: { id: input.policyId },
          select: {
            id: true,
            status: true,
            userId: true,
            organizationId: true,
            title: true,
            generationMetadata: true,
            deletedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        if (!policy || policy.deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Policy not found',
          });
        }

        // Access control
        if (ctx.user!.role !== 'ADMIN') {
          const hasAccess = policy.organizationId
            ? policy.organizationId === ctx.orgMembership!.organizationId
            : policy.userId === ctx.user!.id;
          if (!hasAccess) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Access denied to this policy',
            });
          }
        }

        // Derive a numeric progress from the status
        const progressMap: Record<string, number> = {
          DRAFT: 0,
          GENERATING: 50,
          COMPLETED: 100,
          FAILED: 0,
          ARCHIVED: 100,
        };

        const meta = policy.generationMetadata as Record<string, any> | null;

        return {
          policyId: policy.id,
          title: policy.title,
          status: policy.status,
          progress: progressMap[policy.status] ?? 0,
          isComplete: policy.status === 'COMPLETED',
          isFailed: policy.status === 'FAILED',
          errorMessage: meta?.error ?? null,
          generatedAt: meta?.generatedAt ?? null,
          tokensUsed: meta?.tokensUsed ?? null,
          updatedAt: policy.updatedAt,
        };
      } catch (error: any) {
        logger.error({
          type: 'policy_get_status_error',
          userId: ctx.user!.id,
          policyId: input.policyId,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get policy status',
          cause: error,
        });
      }
    }),

  /**
   * Get version history for a policy
   *
   * Returns the chain of versions linked via the parentId relation on Policy.
   *
   * @protected
   */
  getVersionHistory: orgMemberProcedure
    .input(z.object({ policyId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      try {
        const policy = await ctx.prisma.policy.findUnique({
          where: { id: input.policyId },
          select: {
            id: true,
            userId: true,
            organizationId: true,
            parentId: true,
            deletedAt: true,
            version: true,
          },
        });

        if (!policy || policy.deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Policy not found',
          });
        }

        // Access control
        if (ctx.user!.role !== 'ADMIN') {
          const hasAccess = policy.organizationId
            ? policy.organizationId === ctx.orgMembership!.organizationId
            : policy.userId === ctx.user!.id;
          if (!hasAccess) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Access denied to this policy',
            });
          }
        }

        // Resolve root policy ID (walk up parentId chain if needed)
        const rootId = policy.parentId ?? policy.id;

        // Fetch all versions in the family
        const versions = await ctx.prisma.policy.findMany({
          where: {
            OR: [
              { id: rootId },
              { parentId: rootId },
            ],
            deletedAt: null,
          },
          orderBy: { version: 'asc' },
          select: {
            id: true,
            title: true,
            version: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            isLatestVersion: true,
          },
        });

        return {
          policyId: input.policyId,
          rootId,
          versions,
        };
      } catch (error: any) {
        logger.error({
          type: 'policy_version_history_error',
          userId: ctx.user!.id,
          policyId: input.policyId,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get policy version history',
          cause: error,
        });
      }
    }),
});
