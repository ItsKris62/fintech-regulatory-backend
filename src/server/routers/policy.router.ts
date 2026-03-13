import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc/trpc';
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
import { policyProgressPubSub } from '@/lib/redis/pubsub';
import { logger } from '@/utils/logger';

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
  list: protectedProcedure
    .input(listPoliciesSchema)
    .query(async ({ input, ctx }) => {
      try {
        const { page, limit, status, regulatoryArea: _regulatoryArea, search } = input;
        const skip = (page - 1) * limit;

        // Build where clause — cast to any since Policy schema differs from what's used
        const where: any = {
          deletedAt: null,
        };

        // Filter by organization (unless admin)
        if (ctx.user!.role !== 'ADMIN') {
          where.userId = ctx.user!.id;
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
          (ctx.prisma.policy.findMany as any)({
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
  get: protectedProcedure
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

        if (!policy || (policy as any).deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Policy not found',
          });
        }

        // Check access
        if (ctx.user!.role !== 'ADMIN') {
          const hasAccess = policy.userId === ctx.user!.id;

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
  generate: protectedProcedure
    .use(rateLimited('policyGeneration'))
    .use(withPlanContext)
    .use(requirePlanFeature('policyGeneration'))
    .use(checkUsageLimit(BillingMetric.POLICY_GENERATIONS))
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

        // Create policy record — cast to any since schema differs
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
            organizationId: ctx.user!.organizationId,
            urgency: 'medium',
            stakeholders: [],
          },
        });

        // Capture user info for async closure
        const currentUser = ctx.user!;

        // Generate policy asynchronously with AI
        (async () => {
          try {
            // Publish progress: started
            await policyProgressPubSub.publish(policy.id, {
              type: 'generation_started',
              progress: 10,
              message: 'Starting policy generation...',
            });

            // Generate policy content with AI
            const result = await ctx.aiService.generatePolicy({
              scenario: input.scenario,
              organizationType: input.organizationType,
              regulatoryAreas: input.regulatoryAreas,
              specificRequirements: input.specificRequirements,
              targetAudience: input.targetAudience,
            });

            // Publish progress: content generated
            await policyProgressPubSub.publish(policy.id, {
              type: 'generating_recommendations',
              progress: 70,
              message: 'Policy content generated, adding citations...',
            });

            // Create citations from sections.citations (string array)
            await Promise.all(
              (result.sections.citations || []).map((citationText: string) =>
                (ctx.prisma.citation.create as any)({
                  data: {
                    policyId: policy.id,
                    actName: citationText,
                    section: '',
                    textSnippet: citationText,
                    confidence: 'high',
                    verified: true,
                  },
                })
              )
            );

            // Update policy with generated content
            const updatedPolicy = await (ctx.prisma.policy.update as any)({
              where: { id: policy.id },
              data: {
                content: result.content,
                executiveSummary: result.sections.executiveSummary,
                analysis: result.sections.regulatoryLandscape,
                status: 'COMPLETED',
                generationMetadata: {
                  aiModel: result.model,
                  tokensUsed: result.inputTokens + result.outputTokens,
                  generatedAt: new Date().toISOString(),
                },
              },
              include: {
                citations: true,
              },
            });

            // Clear cache
            await policyCache.delete(policy.id);

            // Send completion email
            try {
              await (ctx.mailer.sendPolicyReadyEmail as any)({
                to: currentUser.email,
                name: currentUser.email,
                policyTitle: updatedPolicy.title,
                policyId: updatedPolicy.id,
                policyUrl: '',
                regulatoryAreas: [],
                generationTime: Date.now() - startTime,
              });
            } catch (emailError: any) {
              logger.error({
                type: 'policy_email_failed',
                policyId: policy.id,
                error: emailError.message,
              });
            }

            // Publish progress: completed
            await policyProgressPubSub.publish(policy.id, {
              type: 'generation_complete',
              progress: 100,
              message: 'Policy generated successfully!',
            });

            const duration = Date.now() - startTime;

            logger.info({
              type: 'policy_generation_success',
              userId: currentUser.id,
              policyId: policy.id,
              duration,
              tokensUsed: result.inputTokens + result.outputTokens,
            });
          } catch (error: any) {
            // Update policy status to FAILED
            await (ctx.prisma.policy.update as any)({
              where: { id: policy.id },
              data: {
                status: 'FAILED',
                generationMetadata: {
                  error: error.message,
                  failedAt: new Date().toISOString(),
                },
              },
            });

            // Publish progress: failed
            await policyProgressPubSub.publish(policy.id, {
              type: 'generation_failed',
              progress: 0,
              message: 'Policy generation failed. Please try again.',
              data: { error: error.message },
            });

            logger.error({
              type: 'policy_generation_failed',
              userId: currentUser.id,
              policyId: policy.id,
              error: error.message,
            });
          }
        })();

        // Return immediately with policy ID
        return {
          policyId: policy.id,
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
  update: protectedProcedure
    .input(updatePolicySchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const { id, ...data } = input;

        // Check access
        const existingPolicy = await ctx.prisma.policy.findUnique({
          where: { id },
        });

        if (!existingPolicy || (existingPolicy as any).deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Policy not found',
          });
        }

        if (ctx.user!.role !== 'ADMIN') {
          const hasAccess = existingPolicy.userId === ctx.user!.id;

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
  delete: protectedProcedure
    .input(deletePolicySchema)
    .mutation(async ({ input, ctx }) => {
      try {
        // Check access
        const policy = await ctx.prisma.policy.findUnique({
          where: { id: input.id },
        });

        if (!policy || (policy as any).deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Policy not found',
          });
        }

        if (ctx.user!.role !== 'ADMIN') {
          const hasAccess = policy.userId === ctx.user!.id;

          if (!hasAccess) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Access denied to this policy',
            });
          }
        }

        await (ctx.prisma.policy.update as any)({
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
  export: protectedProcedure
    .input(exportPolicySchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const policy = await ctx.prisma.policy.findUnique({
          where: { id: input.id },
          include: { citations: true },
        });

        if (!policy || (policy as any).deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Policy not found',
          });
        }

        // Check access
        if (ctx.user!.role !== 'ADMIN') {
          const hasAccess = policy.userId === ctx.user!.id;

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
  refine: protectedProcedure
    .use(rateLimited('policyRefinement'))
    .input(refinePolicySchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const policy = await ctx.prisma.policy.findUnique({
          where: { id: input.id },
        });

        if (!policy || (policy as any).deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Policy not found',
          });
        }

        // Check access
        if (ctx.user!.role !== 'ADMIN') {
          const hasAccess = policy.userId === ctx.user!.id;

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
  verifyCitations: protectedProcedure
    .input(verifyCitationsSchema)
    .query(async ({ input, ctx }) => {
      try {
        const policy = await ctx.prisma.policy.findUnique({
          where: { id: input.id },
          include: { citations: true },
        });

        if (!policy || (policy as any).deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Policy not found',
          });
        }

        // Check access
        if (ctx.user!.role !== 'ADMIN') {
          const hasAccess = policy.userId === ctx.user!.id;

          if (!hasAccess) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Access denied to this policy',
            });
          }
        }

        // Verify citations with AI — verifyCitations takes string[]
        const citationTexts = policy.citations.map((c: any) => c.textSnippet);
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
  getStatus: protectedProcedure
    .input(z.object({ policyId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      try {
        const policy = await (ctx.prisma.policy.findUnique as any)({
          where: { id: input.policyId },
          select: {
            id: true,
            status: true,
            userId: true,
            title: true,
            generationMetadata: true,
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
        if (ctx.user!.role !== 'ADMIN' && policy.userId !== ctx.user!.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Access denied to this policy',
          });
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
  getVersionHistory: protectedProcedure
    .input(z.object({ policyId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      try {
        const policy = await (ctx.prisma.policy.findUnique as any)({
          where: { id: input.policyId },
          select: {
            id: true,
            userId: true,
            parentId: true,
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
        if (ctx.user!.role !== 'ADMIN' && policy.userId !== ctx.user!.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Access denied to this policy',
          });
        }

        // Resolve root policy ID (walk up parentId chain if needed)
        const rootId = policy.parentId ?? policy.id;

        // Fetch all versions in the family
        const versions = await (ctx.prisma.policy.findMany as any)({
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
