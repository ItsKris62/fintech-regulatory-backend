/**
 * Checklist Service
 * Business logic for the normalized compliance checklist feature.
 *
 * Architecture:
 *  - generateChecklist()   — creates a GENERATING record, fires background AI
 *                            generation without blocking the HTTP response.
 *  - runGeneration()       — private; RAG → AI → prisma.$transaction; called
 *                            fire-and-forget from generateChecklist().
 *  - getChecklistStatus()  — polling endpoint; applies lazy stale cleanup.
 *  - listChecklists()      — list summary; applies lazy stale cleanup.
 *  - getChecklistDetail()  — full detail with items grouped by category.
 *  - updateItemStatus()    — per-item status toggle; recalculates progress.
 *  - softDeleteChecklist() — sets deletedAt; does not destroy the record.
 *
 * Legacy checklists (checklistData JSON blob + itemProgress map) continue to
 * work via compliance.module.ts.  Use isNormalizedChecklist() to distinguish.
 */

import { prisma } from '@/lib/prisma/client';
import { ragService } from '@/lib/rag/rag.service';
import { aiService } from '@/lib/ai/ai.service';
import { checklistProgressPubSub } from '@/lib/redis/pubsub';
import { logger } from '@/utils/logger';
import { NotFoundError, ForbiddenError } from '@/utils/error';
import { incrementTrialUsage } from '@/modules/trial';
import {
  CHECKLIST_STATUS,
  CHECKLIST_ITEM_STATUS,
  CHECKLIST_STALE_TIMEOUT_MS,
  safeStringArray,
  type ChecklistStatus,
  type ChecklistItemStatus,
  type ChecklistItemPriority,
  type ChecklistGenerateResult,
  type ChecklistStatusResult,
  type ChecklistSummary,
  type ChecklistDetail,
  type ChecklistCategoryDetail,
  type ChecklistItemDetail,
  type UpdateItemResult,
  type UpdateChecklistItemInput,
  type GenerateChecklistAsyncInput,
  type RawChecklistItemRow,
} from './checklist.types';

// ---------------------------------------------------------------------------
// ChecklistService
// ---------------------------------------------------------------------------

class ChecklistService {
  // =========================================================================
  // PUBLIC: Generate
  // =========================================================================

  /**
   * Create a GENERATING checklist record and immediately return its ID.
   * Background AI generation is started fire-and-forget via runGeneration().
   *
   * The caller (tRPC router) returns { checklistId, status: 'GENERATING' }
   * to the frontend, which then polls getChecklistStatus().
   */
  async generateChecklist(
    userId: string,
    orgId:  string,
    input:  GenerateChecklistAsyncInput,
    trialUserId?: string
  ): Promise<ChecklistGenerateResult> {
    logger.info({
      type:          'checklist_generate_request',
      userId,
      orgId,
      productType:   input.productType,
      businessStage: input.businessStage,
    });

    // Create the placeholder record.
    const checklist = await prisma.checklist.create({
      data: {
        userId,
        organizationId: orgId,
        title:              `${input.productType} — ${input.businessStage}`,
        productType:        input.productType,
        businessStage:      input.businessStage,
        targetSegments:     input.targetSegments,
        servicesOffered:    input.servicesOffered,
        additionalConcerns: input.additionalConcerns ?? null,
        items:              [],   // DEPRECATED legacy field — kept for schema compat
        itemProgress:       {},
        progress:           0,
        completedItems:     0,
        status:             CHECKLIST_STATUS.GENERATING,
      },
      select: { id: true },
    });

    logger.info({
      type:        'checklist_placeholder_created',
      userId,
      orgId,
      checklistId: checklist.id,
    });

    // Fire-and-forget.  Errors are caught inside runGeneration and persisted
    // as a FAILED status on the DB record — they do NOT propagate here.
    this.runGeneration(checklist.id, input, userId, trialUserId).catch((err: Error) => {
      // This branch should not be reached; runGeneration has its own catch.
      // Guard against unhandled promise rejection in case of unexpected throw.
      logger.error({
        type:        'checklist_generation_unhandled_rejection',
        checklistId: checklist.id,
        userId,
        error:       err.message,
      });
    });

    return { checklistId: checklist.id, status: 'GENERATING' };
  }

  // =========================================================================
  // PRIVATE: Background Generation Pipeline
  // =========================================================================

  /**
   * Full AI + RAG generation pipeline.  Runs in the background after
   * generateChecklist() returns.  Updates the DB record to IN_PROGRESS on
   * success or FAILED on error.
   */
  private async runGeneration(
    checklistId: string,
    input:       GenerateChecklistAsyncInput,
    userId:      string,
    trialUserId?: string
  ): Promise<void> {
    const startTime = Date.now();

    try {
      // ------------------------------------------------------------------
      // 1. Build enhanced RAG query.
      //    All form inputs are incorporated — including targetSegments and
      //    additionalConcerns which were absent from the legacy query.
      // ------------------------------------------------------------------
      const ragQueryParts: string[] = [
        'Kenya fintech compliance requirements',
        input.productType,
        input.servicesOffered.join(' '),
        input.targetSegments.join(' '),
        input.businessStage,
        'licensing KYC AML data protection CBK regulations',
      ];
      if (input.additionalConcerns) {
        ragQueryParts.push(input.additionalConcerns);
      }
      const ragQuery = ragQueryParts.filter(Boolean).join(' ');

      // Log the constructed query (Additional Instruction 3 requirement).
      logger.info({
        type:        'checklist_rag_query_constructed',
        checklistId,
        userId,
        ragQuery:    ragQuery.slice(0, 400),
      });

      // ------------------------------------------------------------------
      // 2. RAG retrieval with topK = 20.
      //    Checklist generation requests 30+ items across 13 categories;
      //    broader retrieval (20 vs the legacy 15) reduces hallucination
      //    risk on specific section numbers.
      // ------------------------------------------------------------------
      let ragContext: string | undefined;
      let ragSourcesUsed = 0;

      try {
        const ragResults = await ragService.search(ragQuery, {
          topK:     20,
          minScore: 0.5,
        });

        if (ragResults.length > 0) {
          // Deduplicate by first 100 chars of chunkText to avoid repetitive context.
          const seen = new Set<string>();
          const deduplicated = ragResults.filter((r) => {
            const key = r.chunkText.slice(0, 100);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          ragSourcesUsed = deduplicated.length;
          ragContext = deduplicated
            .map(
              (r, i) =>
                `[REGULATORY CONTEXT ${i + 1} — ${r.documentTitle || 'Kenyan Regulation'}]\n${r.chunkText}`
            )
            .join('\n\n---\n\n');

          logger.info({
            type:           'checklist_rag_retrieved',
            checklistId,
            rawResults:     ragResults.length,
            deduplicatedResults: ragSourcesUsed,
          });
        } else {
          logger.warn({
            type:        'checklist_rag_no_results',
            checklistId,
            ragQuery:    ragQuery.slice(0, 200),
          });
        }
      } catch (ragErr: unknown) {
        // RAG failure is non-fatal — fall through with no context.
        // AI will use training knowledge for Kenyan regulatory content.
        logger.warn({
          type:        'checklist_rag_search_failed',
          checklistId,
          error:       (ragErr as Error).message,
        });
      }

      // ------------------------------------------------------------------
      // 3. AI generation via Claude.
      // ------------------------------------------------------------------
      logger.info({
        type:           'checklist_ai_generation_start',
        checklistId,
        hasRagContext:  !!ragContext,
        ragSourcesUsed,
      });

      const { checklist: generatedChecklist, inputTokens, outputTokens } =
        await aiService.streamComplianceChecklist(
          {
            productType:        input.productType,
            businessStage:      input.businessStage,
            targetSegments:     input.targetSegments,
            servicesOffered:    input.servicesOffered,
            additionalConcerns: input.additionalConcerns,
            ragContext,
            ragSourcesUsed,
          },
          (update) => {
            // Publish progress to the in-process EventEmitter so any connected
            // SSE client for this checklistId receives live updates.
            // Fire-and-forget — a failed publish must never abort generation.
            checklistProgressPubSub.publish(checklistId, update).catch(() => {});
          }
        );

      // ------------------------------------------------------------------
      // 4. Map AI output to ChecklistItem DB rows.
      // ------------------------------------------------------------------
      const itemRows: Parameters<typeof prisma.checklistItem.createMany>[0]['data'] = [];
      for (const category of generatedChecklist.categories) {
        category.items.forEach((aiItem, idx) => {
          itemRows.push({
            checklistId,
            category:            category.name,
            // Persist the AI-generated code (e.g. "DP-001") for display and PDF export.
            itemCode:            (aiItem as { id?: string }).id ?? null,
            title:               aiItem.title,
            description:         aiItem.description,
            // guidance is a new field added to the AI output schema.
            // Falls back to null if the model didn't include it (graceful compat).
            guidance:            (aiItem as { guidance?: string }).guidance ?? null,
            regulatoryReference: aiItem.regulatoryBasis,
            actionItems:         aiItem.actionItems ?? [],
            deadline:            aiItem.deadline || null,
            penalty:             aiItem.penalty  || null,
            priority:            aiItem.priority,
            status:              CHECKLIST_ITEM_STATUS.PENDING,
            notes:               null,
            order:               idx,
          });
        });
      }

      const totalItems = itemRows.length;

      const checklistTitle = generatedChecklist.metadata.productType
        ? `${generatedChecklist.metadata.productType} — ${generatedChecklist.metadata.businessStage}`
        : `${input.productType} — ${input.businessStage}`;

      // Build the summary and metadata objects to persist alongside the items.
      const generationSummary = {
        totalCategories:         generatedChecklist.categories.length,
        totalItems,
        criticalItems:           generatedChecklist.metadata.criticalItems,
        highItems:               generatedChecklist.metadata.highItems,
        estimatedCompletionDays: generatedChecklist.metadata.estimatedCompletionDays,
        generatedFor: {
          productType:   input.productType,
          businessStage: input.businessStage,
          services:      input.servicesOffered,
        },
      };

      const generationMetadata = {
        ragSourcesUsed:          ragSourcesUsed,
        estimatedCompletionDays: generatedChecklist.metadata.estimatedCompletionDays,
        generationDurationMs:    Date.now() - startTime,
      };

      // ------------------------------------------------------------------
      // 5. Persist in a single transaction:
      //    a) Create all ChecklistItem rows.
      //    b) Update Checklist to IN_PROGRESS with summary/metadata fields.
      //    Also keep checklistData for legacy readers that may render the
      //    JSON blob (e.g. PDF export on old checklists).
      // ------------------------------------------------------------------
      await prisma.$transaction(async (tx) => {
        await tx.checklistItem.createMany({ data: itemRows });

        await tx.checklist.update({
          where: { id: checklistId },
          data:  {
            title:          checklistTitle,
            status:         CHECKLIST_STATUS.IN_PROGRESS,
            progress:       0,
            completedItems: 0,
            totalItems,
            summary:        generationSummary as unknown as Record<string, unknown>,
            metadata:       generationMetadata as unknown as Record<string, unknown>,
            generatedAt:    new Date(),
            // Preserve the full AI blob — used by legacy PDF export paths.
            checklistData:  generatedChecklist as unknown as Record<string, unknown>,
          },
        });
      });

      // Track token usage for free trial users (fire-and-forget, non-fatal).
      if (trialUserId) {
        incrementTrialUsage(trialUserId, 'totalTokensUsed', inputTokens + outputTokens).catch(() => {});
      }

      logger.info({
        type:          'checklist_generate_success',
        checklistId,
        userId,
        totalItems,
        ragSourcesUsed,
        durationMs:    Date.now() - startTime,
      });
    } catch (err: unknown) {
      const errMsg = (err as Error).message ?? 'Unknown error';

      // Provide a specific, actionable message for token-limit truncation errors.
      const isTruncation = /max_tokens|truncated|schema validation/i.test(errMsg);
      const userFacingError = isTruncation
        ? 'AI response was truncated. Please try again with fewer details in the specific concerns field.'
        : errMsg;

      logger.error({
        type:        'checklist_generate_failed',
        checklistId,
        userId,
        error:       errMsg,
        isTruncation,
        durationMs:  Date.now() - startTime,
      });

      // Mark the stuck GENERATING record as FAILED and persist the error reason
      // in metadata so the frontend can surface it to the user.
      await prisma.checklist
        .update({
          where: { id: checklistId },
          data:  {
            status:   CHECKLIST_STATUS.FAILED,
            metadata: { errorMessage: userFacingError } as unknown as Record<string, unknown>,
          },
        })
        .catch((updateErr: unknown) => {
          logger.warn({
            type:        'checklist_failed_status_update_error',
            checklistId,
            error:       (updateErr as Error).message,
          });
        });
    }
  }

  // =========================================================================
  // PUBLIC: Status (Polling)
  // =========================================================================

  /**
   * Return the current status of a checklist.
   * Applies the lazy stale-generation cleanup: if the record has been
   * GENERATING for > CHECKLIST_STALE_TIMEOUT_MS, it is marked FAILED here
   * (consistent with the billing grace-period lazy evaluation pattern).
   * No cron job required.
   */
  async getChecklistStatus(
    checklistId: string,
    userId:      string,
    orgId:       string
  ): Promise<ChecklistStatusResult> {
    const checklist = await prisma.checklist.findUnique({
      where:  { id: checklistId },
      select: {
        id:             true,
        title:          true,
        status:         true,
        progress:       true,
        completedItems: true,
        totalItems:     true,
        organizationId: true,
        userId:         true,
        createdAt:      true,
        deletedAt:      true,
      },
    });

    if (!checklist || checklist.deletedAt !== null) {
      throw new NotFoundError('Checklist');
    }

    await this.verifyOwnership(checklist, userId, orgId);

    // Lazy stale cleanup.
    let effectiveStatus = checklist.status as ChecklistStatus;
    if (
      effectiveStatus === CHECKLIST_STATUS.GENERATING &&
      Date.now() - checklist.createdAt.getTime() > CHECKLIST_STALE_TIMEOUT_MS
    ) {
      logger.warn({
        type:        'checklist_stale_generating_detected',
        checklistId,
        ageMs:       Date.now() - checklist.createdAt.getTime(),
      });

      await prisma.checklist
        .update({
          where: { id: checklistId },
          data:  {
            status:   CHECKLIST_STATUS.FAILED,
            metadata: { errorMessage: 'Generation timed out. Please try again.' } as unknown as Record<string, unknown>,
          },
        })
        .catch(() => { /* best-effort */ });

      effectiveStatus = CHECKLIST_STATUS.FAILED;
    }

    // Use the denormalized totalItems from DB when available; fall back to a
    // live COUNT for pre-migration records where totalItems is still 0.
    let totalItems = checklist.totalItems;
    if (totalItems === 0) {
      totalItems = await prisma.checklistItem
        .count({ where: { checklistId } })
        .catch(() => 0);
    }

    const isNormalized = totalItems > 0;

    return {
      checklistId:    checklist.id,
      status:         effectiveStatus,
      progress:       checklist.progress,
      completedItems: checklist.completedItems,
      totalItems,
      title:          checklist.title,
      createdAt:      checklist.createdAt,
      isNormalized,
    };
  }

  // =========================================================================
  // PUBLIC: List
  // =========================================================================

  /**
   * List all non-deleted checklists for an organization.
   * Also applies lazy stale cleanup to any GENERATING records older than
   * CHECKLIST_STALE_TIMEOUT_MS found in the result set.
   */
  async listChecklists(
    orgId: string
  ): Promise<ChecklistSummary[]> {
    const checklists = await prisma.checklist.findMany({
      where:   {
        organizationId: orgId,
        deletedAt:      null,
      },
      orderBy: { createdAt: 'desc' },
      select:  {
        id:                 true,
        title:              true,
        productType:        true,
        businessStage:      true,
        targetSegments:     true,
        servicesOffered:    true,
        additionalConcerns: true,
        progress:           true,
        completedItems:     true,
        totalItems:         true,
        status:             true,
        summary:            true,
        metadata:           true,
        checklistData:      true,
        generatedAt:        true,
        createdAt:          true,
        updatedAt:          true,
      },
    });

    const now = Date.now();

    // Collect stale GENERATING IDs for a single bulk update.
    const staleIds: string[] = [];
    for (const c of checklists) {
      if (
        c.status === CHECKLIST_STATUS.GENERATING &&
        now - c.createdAt.getTime() > CHECKLIST_STALE_TIMEOUT_MS
      ) {
        staleIds.push(c.id);
      }
    }

    if (staleIds.length > 0) {
      logger.warn({
        type:     'checklist_stale_bulk_cleanup',
        orgId,
        staleIds,
      });
      await prisma.checklist
        .updateMany({
          where: { id: { in: staleIds } },
          data:  {
            status:   CHECKLIST_STATUS.FAILED,
            metadata: { errorMessage: 'Generation timed out. Please try again.' } as unknown as Record<string, unknown>,
          },
        })
        .catch(() => { /* best-effort — result returned from cached select above */ });
    }

    // Detect normalized checklists: totalItems > 0 means items were persisted via
    // the normalized path. For legacy checklists (totalItems = 0 in DB), fall back
    // to counting items — this handles the backfill gap for pre-migration records.
    const checklistIds = checklists.filter((c) => c.totalItems === 0).map((c) => c.id);
    const legacyItemCounts: Map<string, number> = new Map();

    if (checklistIds.length > 0) {
      try {
        await Promise.all(
          checklistIds.map(async (cid: string) => {
            const count = await prisma.checklistItem.count({ where: { checklistId: cid } });
            legacyItemCounts.set(cid, count);
          })
        );
      } catch {
        // Non-fatal — isNormalized defaults to false for these records.
      }
    }

    return checklists.map((c) => {
      // For records with totalItems already set in DB, use that directly.
      // For older records where totalItems is still 0, use the live count fallback.
      const dbTotalItems  = c.totalItems > 0 ? c.totalItems : (legacyItemCounts.get(c.id) ?? 0);
      const normalized    = dbTotalItems > 0;
      const effectiveStatus: ChecklistStatus = staleIds.includes(c.id)
        ? CHECKLIST_STATUS.FAILED
        : (c.status as ChecklistStatus);

      // For legacy checklists, derive criticalItems from the JSON blob.
      type ChecklistDataShape = {
        metadata?: { totalItems?: number; criticalItems?: number };
      };
      type SummaryShape = { criticalItems?: number };
      const blobData    = c.checklistData as ChecklistDataShape | null;
      const summaryData = c.summary as SummaryShape | null;

      // criticalItems: prefer the summary field (set for normalized checklists),
      // fall back to the legacy blob, then to 0.
      const criticalItems =
        summaryData?.criticalItems ??
        blobData?.metadata?.criticalItems ??
        0;

      return {
        id:                 c.id,
        title:              c.title,
        productType:        c.productType,
        businessStage:      c.businessStage,
        targetSegments:     c.targetSegments,
        servicesOffered:    c.servicesOffered,
        additionalConcerns: c.additionalConcerns,
        progress:           c.progress,
        completedItems:     c.completedItems,
        totalItems:         dbTotalItems,
        criticalItems,
        status:             effectiveStatus,
        metadata:           staleIds.includes(c.id)
          ? { errorMessage: 'Generation timed out. Please try again.' }
          : (c.metadata ?? null),
        generatedAt:        c.generatedAt,
        createdAt:          c.createdAt,
        updatedAt:          c.updatedAt,
        isNormalized:       normalized,
      };
    });
  }

  // =========================================================================
  // PUBLIC: Get Detail
  // =========================================================================

  /**
   * Return the full checklist detail with items grouped by category.
   * Only works for normalized checklists (isNormalized = true).
   */
  async getChecklistDetail(
    checklistId: string,
    userId:      string,
    orgId:       string
  ): Promise<ChecklistDetail> {
    const checklist = await prisma.checklist.findUnique({
      where: { id: checklistId },
    });

    if (!checklist || checklist.deletedAt !== null) {
      throw new NotFoundError('Checklist');
    }

    await this.verifyOwnership(checklist, userId, orgId);

    // Fetch all items sorted by category then order.
    const rawItems = await prisma.checklistItem.findMany({
      where:   { checklistId },
      orderBy: [{ category: 'asc' }, { order: 'asc' }],
    });

    if (rawItems.length === 0) {
      // This checklist has no normalized items — wrong endpoint for legacy checklists.
      throw new NotFoundError(
        'Checklist items (this checklist uses the legacy JSON-blob format — use getChecklist instead)'
      );
    }

    // Group items by category name.
    const categoryMap = new Map<string, RawChecklistItemRow[]>();
    for (const item of rawItems) {
      const existing = categoryMap.get(item.category) ?? [];
      existing.push(item);
      categoryMap.set(item.category, existing);
    }

    const categories: ChecklistCategoryDetail[] = [];
    for (const [catName, items] of categoryMap) {
      const completedCount = items.filter(
        (i) => i.status === CHECKLIST_ITEM_STATUS.COMPLETED
      ).length;
      const totalCount = items.length;

      categories.push({
        name:           catName,
        completedCount,
        totalCount,
        progress:       totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0,
        items:          items.map((i) => this.mapRawItemToDetail(i)),
      });
    }

    const totalItems = rawItems.length;
    const status     = checklist.status as ChecklistStatus;

    return {
      id:                 checklist.id,
      title:              checklist.title,
      productType:        checklist.productType,
      businessStage:      checklist.businessStage,
      targetSegments:     checklist.targetSegments,
      servicesOffered:    checklist.servicesOffered,
      additionalConcerns: checklist.additionalConcerns,
      progress:           checklist.progress,
      completedItems:     checklist.completedItems,
      totalItems,
      status,
      summary:            checklist.summary,
      metadata:           checklist.metadata,
      generatedAt:        checklist.generatedAt,
      createdAt:          checklist.createdAt,
      updatedAt:          checklist.updatedAt,
      completedAt:        checklist.completedAt,
      isNormalized:       true,
      categories,
    };
  }

  // =========================================================================
  // PUBLIC: Update Item Status
  // =========================================================================

  /**
   * Update the status (and optional notes) of a single ChecklistItem.
   * Recalculates parent checklist progress and completedItems count.
   * If all items are COMPLETED or NOT_APPLICABLE, marks the checklist COMPLETED.
   *
   * Uses server-response-wins reconciliation: the returned values are the
   * authoritative server state that the frontend must apply via setQueryData.
   */
  async updateItemStatus(
    userId:  string,
    orgId:   string,
    input:   UpdateChecklistItemInput
  ): Promise<UpdateItemResult> {
    // 1. Fetch the item.
    const item = await prisma.checklistItem.findUnique({
      where: { id: input.itemId },
    });

    if (!item) {
      throw new NotFoundError('ChecklistItem');
    }

    // 2. Verify the checklist belongs to the caller's org.
    const checklist = await prisma.checklist.findUnique({
      where:  { id: item.checklistId },
      select: { id: true, organizationId: true, userId: true, deletedAt: true },
    });

    if (!checklist || checklist.deletedAt !== null) {
      throw new NotFoundError('Checklist');
    }

    await this.verifyOwnership(checklist, userId, orgId);

    // 3. Validate that the checklistId in the input matches the item's checklist.
    if (item.checklistId !== input.checklistId) {
      throw new ForbiddenError('Item does not belong to the specified checklist');
    }

    // 4. Update the item.
    const isCompleting = input.status === CHECKLIST_ITEM_STATUS.COMPLETED;
    const updatedItem = await prisma.checklistItem.update({
      where: { id: input.itemId },
      data:  {
        status:      input.status,
        notes:       input.notes !== undefined ? input.notes : item.notes,
        completedAt: isCompleting ? new Date() : null,
        completedById: isCompleting ? userId : null,
      },
    });

    // 5. Recalculate progress from all sibling items.
    const allItems = await prisma.checklistItem.findMany({
      where: { checklistId: item.checklistId },
    });

    const totalItems    = allItems.length;
    const completedItems = allItems.filter(
      (i) => i.status === CHECKLIST_ITEM_STATUS.COMPLETED
    ).length;
    // Items marked NOT_APPLICABLE are excluded from the denominator so they
    // don't artificially inflate progress.
    const activeItems   = allItems.filter(
      (i) => i.status !== CHECKLIST_ITEM_STATUS.NOT_APPLICABLE
    ).length;
    const activeCompleted = allItems.filter(
      (i) => i.status === CHECKLIST_ITEM_STATUS.COMPLETED
    ).length;
    const progress = activeItems > 0
      ? Math.round((activeCompleted / activeItems) * 100)
      : 0;

    // All items are either completed or not-applicable → mark checklist done.
    const allResolved = totalItems > 0 && allItems.every(
      (i) =>
        i.status === CHECKLIST_ITEM_STATUS.COMPLETED ||
        i.status === CHECKLIST_ITEM_STATUS.NOT_APPLICABLE
    );
    const newChecklistStatus: ChecklistStatus = allResolved
      ? CHECKLIST_STATUS.COMPLETED
      : CHECKLIST_STATUS.IN_PROGRESS;
    const completedAt = allResolved ? new Date() : null;

    // 6. Persist recalculated values (also keep totalItems denormalized field in sync).
    const updatedChecklist = await prisma.checklist.update({
      where: { id: item.checklistId },
      data:  {
        progress,
        completedItems,
        totalItems,
        status:      newChecklistStatus,
        completedAt,
      },
      select: {
        id:             true,
        progress:       true,
        completedItems: true,
        status:         true,
        completedAt:    true,
      },
    });

    logger.info({
      type:            'checklist_item_updated',
      userId,
      orgId,
      checklistId:     item.checklistId,
      itemId:          input.itemId,
      newStatus:       input.status,
      progress,
      completedItems,
      checklistStatus: newChecklistStatus,
    });

    // TODO: Trigger completion email notification
    // When progress === 100 and newChecklistStatus === 'COMPLETED', send a
    // "Checklist Complete" email to the user and optionally their org admin.
    // Use Resend + React Email.
    // Template to be created: src/emails/templates/compliance/checklist-completion.tsx
    // See existing templates in src/emails/templates/ for the pattern.

    return {
      item: {
        id:          updatedItem.id,
        status:      updatedItem.status as ChecklistItemStatus,
        notes:       updatedItem.notes,
        completedAt: updatedItem.completedAt,
      },
      checklist: {
        id:             updatedChecklist.id,
        progress:       updatedChecklist.progress,
        completedItems: updatedChecklist.completedItems,
        status:         updatedChecklist.status as ChecklistStatus,
        completedAt:    updatedChecklist.completedAt,
      },
    };
  }

  // =========================================================================
  // PUBLIC: Soft Delete
  // =========================================================================

  /**
   * Soft-delete a checklist by setting deletedAt.
   * The record is retained in the database for audit purposes.
   * Works for both normalized and legacy checklists.
   */
  async softDeleteChecklist(
    checklistId: string,
    userId:      string,
    orgId:       string
  ): Promise<void> {
    const checklist = await prisma.checklist.findUnique({
      where:  { id: checklistId },
      select: { id: true, organizationId: true, userId: true, deletedAt: true },
    });

    if (!checklist || checklist.deletedAt !== null) {
      throw new NotFoundError('Checklist');
    }

    await this.verifyOwnership(checklist, userId, orgId);

    await prisma.checklist.update({
      where: { id: checklistId },
      data:  { deletedAt: new Date() },
    });

    logger.info({ type: 'checklist_soft_deleted', userId, orgId, checklistId });
  }

  // =========================================================================
  // PUBLIC: Utility — Normalized Detection
  // =========================================================================

  /**
   * Returns true when the checklist has at least one normalized ChecklistItem
   * record, distinguishing it from legacy JSON-blob checklists.
   *
   * Use this in the frontend (via the `isNormalized` flag returned by list/status
   * endpoints) to decide which mutation to call:
   *  - isNormalized = true  → compliance.updateChecklistItem (per-item update)
   *  - isNormalized = false → compliance.updateChecklistProgress (legacy blob update)
   */
  async isNormalizedChecklist(checklistId: string): Promise<boolean> {
    const count = await prisma.checklistItem
      .count({ where: { checklistId } })
      .catch(() => 0);
    return count > 0;
  }

  // =========================================================================
  // PRIVATE: Helpers
  // =========================================================================

  /**
   * Verify that the given checklist belongs to the caller's organization.
   * Regulators accessing shared checklists is a future TODO — not implemented.
   */
  private async verifyOwnership(
    checklist: { organizationId: string | null; userId: string },
    userId:    string,
    orgId:     string
  ): Promise<void> {
    // Org-level access: any member of the org can read.
    if (checklist.organizationId && checklist.organizationId === orgId) {
      return;
    }

    // Fallback to user-level ownership (handles checklists created before
    // organizationId was made non-nullable).
    if (checklist.userId === userId) {
      return;
    }

    // Check ADMIN role as final fallback.
    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: { role: true },
    });
    if (user?.role === 'ADMIN') {
      return;
    }

    throw new ForbiddenError('You do not have access to this checklist');
  }

  /** Map a raw DB row to the typed ChecklistItemDetail output shape. */
  private mapRawItemToDetail(raw: RawChecklistItemRow): ChecklistItemDetail {
    return {
      id:                  raw.id,
      category:            raw.category,
      itemCode:            raw.itemCode,
      title:               raw.title,
      description:         raw.description,
      guidance:            raw.guidance,
      regulatoryReference: raw.regulatoryReference,
      actionItems:         safeStringArray(raw.actionItems),
      deadline:            raw.deadline,
      penalty:             raw.penalty,
      priority:            raw.priority as ChecklistItemPriority,
      status:              raw.status  as ChecklistItemStatus,
      notes:               raw.notes,
      order:               raw.order,
      completedAt:         raw.completedAt,
      completedById:       raw.completedById,
    };
  }
}

// Export singleton instance and class.
export const checklistService = new ChecklistService();
export { ChecklistService };
