import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, orgMemberProcedure } from '../trpc/trpc';
import { BillingMetric, SubscriptionPlan } from '@prisma/client';
import { rateLimited, withPlanContext, requirePlanFeature, checkUsageLimit } from '../trpc/middleware';
import { complianceModule } from '@/modules/compliance';
import { checklistService } from '@/modules/compliance/checklist.service';
import {
  generateChecklistAsyncInputSchema,
  updateChecklistItemInputSchema,
  getChecklistStatusInputSchema,
} from '@/modules/compliance/checklist.types';
import { logger } from '@/utils/logger';
import { redis } from '@/lib/redis/client';
import { getQuota } from '@/utils/entitlements';

export const checklistRouter = router({
  /**
   * Generate an AI+RAG compliance checklist.
   * Requires authentication and active org membership. RBAC: STARTUP, ENTERPRISE, ADMIN.
   *
   * Security: organizationId is derived exclusively from ctx.orgMembership
   * (set by requireOrgMembership via orgMemberProcedure) and never from the
   * request body, closing the IDOR that allowed cross-tenant org attribution.
   *
   * @protected @org-member @rate-limited
   */
  generateChecklist: orgMemberProcedure
    .use(rateLimited('complianceQuery'))
    .use(withPlanContext)
    .use(requirePlanFeature('checklistGenerations'))
    .use(checkUsageLimit(BillingMetric.CHECKLIST_GENERATIONS))
    .input(
      z.object({
        productType: z.string().min(1).max(100),
        businessStage: z.string().min(1).max(100),
        targetSegments: z.array(z.string()).min(1).max(10),
        servicesOffered: z.array(z.string()).min(1).max(20),
        additionalConcerns: z.string().max(1000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        // RBAC: Regulators cannot generate checklists (they issue them)
        if (ctx.user!.role === 'REGULATOR') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Regulators cannot generate compliance checklists',
          });
        }

        // orgId is always session-derived -- never client-supplied (IDOR closed)
        const orgId  = ctx.orgMembership!.organizationId;
        const userId = ctx.user!.id;

        logger.info({
          type:          'checklist_generate_request',
          userId,
          orgId,
          productType:   input.productType,
          businessStage: input.businessStage,
        });

        const result = await complianceModule.generateChecklist(userId, {
          productType:        input.productType,
          businessStage:      input.businessStage,
          targetSegments:     input.targetSegments,
          servicesOffered:    input.servicesOffered,
          additionalConcerns: input.additionalConcerns,
          organizationId:     orgId,
        });

        logger.info({
          type:        'checklist_generate_success',
          userId,
          checklistId: result.id,
        });

        return result;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to generate compliance checklist';
        logger.error({ type: 'checklist_generate_error', userId: ctx.user!.id, error: msg });
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg, cause: error });
      }
    }),

  /**
   * List all checklists for the current user.
   *
   * @protected
   */
  getUserChecklists: protectedProcedure.query(async ({ ctx }) => {
    try {
      const checklists = await complianceModule.getUserChecklists(ctx.user!.id);
      logger.info({ type: 'user_checklists_retrieved', userId: ctx.user!.id, count: checklists.length });
      return checklists;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to retrieve checklists';
      logger.error({ type: 'user_checklists_error', userId: ctx.user!.id, error: msg });
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg, cause: error });
    }
  }),

  /**
   * Get a single checklist by ID.
   *
   * @protected
   */
  getChecklist: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      try {
        const checklist = await complianceModule.getChecklist(ctx.user!.id, input.id);
        logger.info({ type: 'checklist_retrieved', userId: ctx.user!.id, checklistId: input.id });
        return checklist;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to retrieve checklist';
        logger.error({ type: 'checklist_retrieve_error', userId: ctx.user!.id, checklistId: input.id, error: msg });
        if (msg === 'Checklist not found') throw new TRPCError({ code: 'NOT_FOUND', message: msg });
        if (msg.includes('Access denied')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied to this checklist' });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to retrieve checklist', cause: error });
      }
    }),

  /**
   * @deprecated Use `updateChecklistItem` for normalized checklists (post-March 2026).
   * Kept for backward-compatibility with legacy JSON-blob checklists only.
   *
   * @protected
   * @middleware withPlanContext
   */
  updateChecklistProgress: protectedProcedure
    .use(withPlanContext)
    .input(
      z.object({
        checklistId: z.string().min(1),
        itemProgress: z.record(z.string(), z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'])),
      })
    )
    .mutation(async ({ input, ctx }) => {
      logger.warn({
        type: 'deprecated_procedure_called',
        procedure: 'checklist.updateChecklistProgress',
        replacement: 'checklist.updateChecklistItem',
        userId: ctx.user!.id,
        checklistId: input.checklistId,
        message: 'updateChecklistProgress is deprecated. Migrate to updateChecklistItem for normalized checklists.',
      });

      try {
        const result = await complianceModule.updateChecklistProgress(
          ctx.user!.id,
          input.checklistId,
          input.itemProgress
        );
        logger.info({ type: 'checklist_progress_update_success', userId: ctx.user!.id, checklistId: input.checklistId, progress: result.progress });
        return result;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to update checklist progress';
        logger.error({ type: 'checklist_progress_update_error', userId: ctx.user!.id, checklistId: input.checklistId, error: msg });
        if (msg === 'Checklist not found') throw new TRPCError({ code: 'NOT_FOUND', message: msg });
        if (msg.includes('Access denied')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        if (msg.includes('Invalid')) throw new TRPCError({ code: 'BAD_REQUEST', message: msg });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update checklist progress', cause: error });
      }
    }),

  /**
   * Soft-delete a checklist (sets deletedAt; record is NOT destroyed).
   *
   * @protected
   * @middleware withPlanContext
   */
  deleteChecklist: protectedProcedure
    .use(withPlanContext)
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      try {
        await complianceModule.deleteChecklist(ctx.user!.id, input.id);
        logger.info({ type: 'checklist_deleted', userId: ctx.user!.id, checklistId: input.id });
        return { success: true };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to delete checklist';
        logger.error({ type: 'checklist_delete_error', userId: ctx.user!.id, checklistId: input.id, error: msg });
        if (msg === 'Checklist not found') throw new TRPCError({ code: 'NOT_FOUND', message: msg });
        if (msg.includes('Access denied')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to delete checklist', cause: error });
      }
    }),

  // ══════════════════════════════════════════════════════════════════════════
  // NORMALIZED CHECKLIST PROCEDURES (post-March 2026)
  //
  // Middleware policy:
  //   READ queries  -- no plan gate (reads are free)
  //   WRITE mutations -- withPlanContext applied; requirePlanFeature NOT applied
  //     (plan gate already enforced on generateChecklistAsync via checkUsageLimit)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Fire-and-forget checklist generation.
   * Returns immediately with { checklistId, status: 'GENERATING' }.
   * Frontend must poll `getChecklistStatus` until status leaves GENERATING.
   *
   * @protected
   * @middleware withPlanContext + checkUsageLimit
   */
  generateChecklistAsync: orgMemberProcedure
    .use(rateLimited('complianceQuery'))
    .use(withPlanContext)
    // deferIncrement: true -- usage counter committed only after DB placeholder written
    .use(checkUsageLimit(BillingMetric.CHECKLIST_GENERATIONS, { deferIncrement: true }))
    .input(generateChecklistAsyncInputSchema)
    .mutation(async ({ input, ctx }) => {
      if (ctx.user!.role === 'REGULATOR') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Regulators cannot generate compliance checklists',
        });
      }

      const orgId = ctx.orgMembership!.organizationId;

      // B7.3 (TD-009): Redis dedup lock — prevents double-submit from starting two
      // Claude AI pipelines simultaneously. Lock is keyed on userId+productType+stage
      // so different checklist types are not blocked by each other. TTL = 60s
      // (covers the full async pipeline initiation time). nx=true = only set if absent.
      const checklistLockKey = `lock:checklist:${ctx.user!.id}:${input.productType}:${input.businessStage}`;
      const lockAcquired = await redis.set(checklistLockKey, '1', { ex: 60, nx: true });
      if (!lockAcquired) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'A checklist generation is already in progress. Please wait for it to complete.',
        });
      }

      try {
        logger.info({
          type: 'checklist_generate_async_start',
          userId: ctx.user!.id,
          orgId,
          productType: input.productType,
          businessStage: input.businessStage,
        });

        const result = await checklistService.generateChecklist(
          ctx.user!.id,
          orgId,
          input,
          ctx.plan === 'FREE_TRIAL' ? ctx.user!.id : undefined,
        );

        await ctx.incrementUsage?.();

        // Release lock after the pipeline is queued (not after it completes —
        // the pipeline runs in the background after this response is sent).
        await redis.del(checklistLockKey);

        logger.info({ type: 'checklist_generate_async_accepted', userId: ctx.user!.id, checklistId: result.checklistId });
        return result;
      } catch (error: unknown) {
        // Always release the lock on error so the user can retry immediately.
        await redis.del(checklistLockKey).catch(() => {});
        const msg = error instanceof Error ? error.message : 'Failed to initiate checklist generation';
        logger.error({ type: 'checklist_generate_async_error', userId: ctx.user!.id, error: msg });
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg, cause: error });
      }
    }),

  /**
   * Poll the status of a generating checklist.
   * Frontend should call every 3s until status !== 'GENERATING'.
   *
   * READ -- no plan gate.
   *
   * @protected
   */
  getChecklistStatus: orgMemberProcedure
    .input(getChecklistStatusInputSchema)
    .query(async ({ input, ctx }) => {
      const orgId = ctx.orgMembership!.organizationId;
      try {
        return await checklistService.getChecklistStatus(input.checklistId, ctx.user!.id, orgId);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to get checklist status';
        if (error instanceof TRPCError) throw error;
        if (msg === 'Checklist not found') throw new TRPCError({ code: 'NOT_FOUND', message: msg });
        if (msg.includes('Access denied')) throw new TRPCError({ code: 'FORBIDDEN', message: msg });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg, cause: error });
      }
    }),

  /**
   * List all checklists for the caller's organization (normalized path).
   * Excludes soft-deleted records.
   *
   * READ -- no plan gate.
   *
   * @protected
   */
  listChecklists: orgMemberProcedure.query(async ({ ctx }) => {
    const orgId = ctx.orgMembership!.organizationId;
    try {
      return await checklistService.listChecklists(orgId);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to list checklists';
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg, cause: error });
    }
  }),

  /**
   * Get full checklist detail with categories + items (normalized checklists only).
   *
   * READ -- no plan gate.
   *
   * @protected
   */
  getChecklistDetail: orgMemberProcedure
    .input(z.object({ checklistId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      const orgId = ctx.orgMembership!.organizationId;
      try {
        return await checklistService.getChecklistDetail(input.checklistId, ctx.user!.id, orgId);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to get checklist detail';
        if (error instanceof TRPCError) throw error;
        if (msg === 'Checklist not found') throw new TRPCError({ code: 'NOT_FOUND', message: msg });
        if (msg.includes('Access denied')) throw new TRPCError({ code: 'FORBIDDEN', message: msg });
        if (msg.includes('Legacy checklist')) throw new TRPCError({ code: 'BAD_REQUEST', message: msg });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg, cause: error });
      }
    }),

  /**
   * Update a single normalized ChecklistItem's status and optional notes.
   *
   * @protected
   * @middleware withPlanContext
   */
  updateChecklistItem: orgMemberProcedure
    .use(withPlanContext)
    .input(updateChecklistItemInputSchema)
    .mutation(async ({ input, ctx }) => {
      const orgId = ctx.orgMembership!.organizationId;
      try {
        const result = await checklistService.updateItemStatus(ctx.user!.id, orgId, input);
        logger.info({
          type: 'checklist_item_updated',
          userId: ctx.user!.id,
          checklistId: input.checklistId,
          itemId: input.itemId,
          newStatus: input.status,
          checklistProgress: result.checklist.progress,
        });
        return result;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to update checklist item';
        if (error instanceof TRPCError) throw error;
        if (msg === 'Checklist not found' || msg === 'Checklist item not found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: msg });
        }
        if (msg.includes('Access denied')) throw new TRPCError({ code: 'FORBIDDEN', message: msg });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg, cause: error });
      }
    }),

  /**
   * Return the caller's checklist generation usage for the current period.
   *
   * READ -- no plan gate.
   *
   * @protected
   */
  getChecklistUsage: orgMemberProcedure
    .use(withPlanContext)
    .query(async ({ ctx }) => {
      const plan     = ctx.plan ?? SubscriptionPlan.REGULATOR;
      const scopeId  = ctx.orgMembership!.organizationId;
      const { limit, period } = getQuota(plan, 'checklistGenerations');

      if (limit === -1) {
        return { used: 0, limit: -1, period, planName: plan };
      }

      const periodKey = period === 'lifetime' ? 'lifetime' : new Date().toISOString().slice(0, 7);
      const usageKey  = `sheriabot:usage:${scopeId}:${BillingMetric.CHECKLIST_GENERATIONS}:${periodKey}`;

      const raw  = await redis.get<number>(usageKey);
      const used = typeof raw === 'number' ? raw : Number(raw ?? 0);

      return { used, limit, period, planName: plan };
    }),

  /**
   * Retry a FAILED checklist generation.
   * Resets the record to GENERATING and re-fires the pipeline.
   * Does NOT consume additional generation credits. Capped at 3 retries.
   *
   * @protected
   * @middleware withPlanContext -- no checkUsageLimit (no credit consumed on retry)
   */
  retryChecklist: orgMemberProcedure
    .use(withPlanContext)
    .input(z.object({ checklistId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user!.id;
      const orgId = ctx.orgMembership!.organizationId;

      try {
        const result = await checklistService.retryChecklist(input.checklistId, userId, orgId);
        logger.info({ type: 'checklist_retry_queued', userId, checklistId: input.checklistId, retryCount: result.retryCount });
        return result;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to retry checklist generation';
        logger.error({ type: 'checklist_retry_error', userId, checklistId: input.checklistId, error: msg });
        if (msg === 'Checklist not found') throw new TRPCError({ code: 'NOT_FOUND', message: msg });
        if (msg.includes('Access denied') || msg.includes('do not own')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        if (msg.includes('not in FAILED')) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only FAILED checklists can be retried' });
        if (msg.includes('Maximum retry')) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Maximum retry attempts reached for this checklist' });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to retry checklist generation', cause: error });
      }
    }),
});
