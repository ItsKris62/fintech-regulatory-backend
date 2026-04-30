/**
 * Admin Marketing Router
 *
 * All procedures require ADMIN role (via adminProcedure).
 *
 * Procedures:
 *   campaigns.list                — paginated campaign list with optional status filter
 *   campaigns.getById             — single campaign by ID
 *   campaigns.create              — create a new DRAFT campaign
 *   campaigns.update              — update a DRAFT/SCHEDULED campaign
 *   campaigns.delete              — delete a non-SENDING campaign
 *   campaigns.requestSendConfirmation — step 1 of 2-step send (returns token + preview)
 *   campaigns.executeSend         — step 2 of 2-step send (validates token, fires send)
 *   campaigns.cancel              — cancel a DRAFT/SCHEDULED campaign
 *   campaigns.getStats            — aggregate stats for the detail page
 *   campaigns.getRecentSends      — recent CampaignSend rows for the detail page
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { MarketingCampaignStatus, MarketingTemplateKey } from '@prisma/client';
import { router, adminProcedure } from '../trpc/trpc';
import { campaignService, RecipientLimitError } from '@/modules/marketing/campaign.service';
import { BadRequestError, NotFoundError } from '@/utils/error';

// ---------------------------------------------------------------------------
// Error mapping helper
// ---------------------------------------------------------------------------

function mapServiceError(error: unknown): never {
  if (error instanceof TRPCError) throw error;

  if (error instanceof RecipientLimitError) {
    throw new TRPCError({
      code:    'BAD_REQUEST',
      message: error.message,
    });
  }

  if (error instanceof NotFoundError) {
    throw new TRPCError({
      code:    'NOT_FOUND',
      message: error.message,
    });
  }

  if (error instanceof BadRequestError) {
    throw new TRPCError({
      code:    'BAD_REQUEST',
      message: error.message,
    });
  }

  throw new TRPCError({
    code:    'INTERNAL_SERVER_ERROR',
    message: error instanceof Error ? error.message : 'An unexpected error occurred.',
  });
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const CAMPAIGN_STATUS_VALUES = Object.values(MarketingCampaignStatus) as [MarketingCampaignStatus, ...MarketingCampaignStatus[]];
const TEMPLATE_KEY_VALUES    = Object.values(MarketingTemplateKey)    as [MarketingTemplateKey,    ...MarketingTemplateKey[]];

const campaignListInput = z.object({
  status:      z.enum(CAMPAIGN_STATUS_VALUES).optional(),
  createdById: z.string().optional(),
  take:        z.number().int().min(1).max(100).default(20),
  skip:        z.number().int().min(0).default(0),
});

const campaignByIdInput = z.object({
  id: z.string().min(1),
});

const createCampaignInput = z.object({
  name:              z.string().min(1).max(200),
  subject:           z.string().min(1).max(500),
  templateKey:       z.enum(TEMPLATE_KEY_VALUES),
  templateVariables: z.record(z.unknown()),
  listId:            z.string().min(1),
});

const updateCampaignInput = z.object({
  id:                z.string().min(1),
  name:              z.string().min(1).max(200).optional(),
  subject:           z.string().min(1).max(500).optional(),
  templateVariables: z.record(z.unknown()).optional(),
  listId:            z.string().min(1).optional(),
  scheduledFor:      z.string().datetime().optional().nullable(),
});

const deleteCampaignInput = z.object({
  id: z.string().min(1),
});

const requestSendConfirmationInput = z.object({
  campaignId: z.string().min(1),
});

const executeSendInput = z.object({
  campaignId:              z.string().min(1),
  confirmationToken:       z.string().min(1),
  confirmedRecipientCount: z.number().int().min(0),
});

const cancelCampaignInput = z.object({
  campaignId: z.string().min(1),
});

const getStatsInput = z.object({
  campaignId: z.string().min(1),
});

const getRecentSendsInput = z.object({
  campaignId: z.string().min(1),
  take:       z.number().int().min(1).max(200).default(50),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const adminMarketingRouter = router({
  campaigns: router({
    /**
     * Paginated list of campaigns with optional status filter.
     */
    list: adminProcedure
      .input(campaignListInput)
      .query(async ({ input }) => {
        try {
          return await campaignService.list({
            status:      input.status as MarketingCampaignStatus | undefined,
            createdById: input.createdById,
            take:        input.take,
            skip:        input.skip,
          });
        } catch (error: unknown) {
          mapServiceError(error);
        }
      }),

    /**
     * Get a single campaign by ID.
     */
    getById: adminProcedure
      .input(campaignByIdInput)
      .query(async ({ input }) => {
        try {
          const campaign = await campaignService.getById(input.id);
          if (!campaign) {
            throw new TRPCError({ code: 'NOT_FOUND', message: `Campaign '${input.id}' not found` });
          }
          return campaign;
        } catch (error: unknown) {
          mapServiceError(error);
        }
      }),

    /**
     * Create a new DRAFT campaign.
     */
    create: adminProcedure
      .input(createCampaignInput)
      .mutation(async ({ input, ctx }) => {
        try {
          return await campaignService.create({
            name:              input.name,
            subject:           input.subject,
            templateKey:       input.templateKey as MarketingTemplateKey,
            templateVariables: input.templateVariables,
            listId:            input.listId,
            createdById:       ctx.user!.id,
          });
        } catch (error: unknown) {
          mapServiceError(error);
        }
      }),

    /**
     * Update a DRAFT or SCHEDULED campaign.
     */
    update: adminProcedure
      .input(updateCampaignInput)
      .mutation(async ({ input, ctx }) => {
        try {
          const { id, scheduledFor, ...rest } = input;
          return await campaignService.update(
            id,
            {
              ...rest,
              scheduledFor: scheduledFor !== undefined
                ? (scheduledFor ? new Date(scheduledFor) : null)
                : undefined,
            },
            ctx.user!.id,
          );
        } catch (error: unknown) {
          mapServiceError(error);
        }
      }),

    /**
     * Delete a campaign (not allowed while SENDING).
     */
    delete: adminProcedure
      .input(deleteCampaignInput)
      .mutation(async ({ input, ctx }) => {
        try {
          await campaignService.delete(input.id, ctx.user!.id);
          return { success: true };
        } catch (error: unknown) {
          mapServiceError(error);
        }
      }),

    /**
     * Step 1 of 2-step send confirmation.
     * Resolves recipients, enforces 25-cap, stores Redis token.
     * Returns: { confirmationToken, recipientCount, estimatedDurationSeconds, expiresAt }
     */
    requestSendConfirmation: adminProcedure
      .input(requestSendConfirmationInput)
      .mutation(async ({ input, ctx }) => {
        try {
          return await campaignService.requestSendConfirmation({
            campaignId:    input.campaignId,
            requestedById: ctx.user!.id,
          });
        } catch (error: unknown) {
          mapServiceError(error);
        }
      }),

    /**
     * Step 2 of 2-step send confirmation.
     * Validates token, re-resolves recipients, fires sequential send loop.
     * Returns: { campaignId, finalStatus, sent, skipped, failed }
     */
    executeSend: adminProcedure
      .input(executeSendInput)
      .mutation(async ({ input, ctx }) => {
        try {
          return await campaignService.executeSend({
            campaignId:              input.campaignId,
            confirmationToken:       input.confirmationToken,
            confirmedRecipientCount: input.confirmedRecipientCount,
            executedById:            ctx.user!.id,
          });
        } catch (error: unknown) {
          mapServiceError(error);
        }
      }),

    /**
     * Cancel a DRAFT or SCHEDULED campaign.
     */
    cancel: adminProcedure
      .input(cancelCampaignInput)
      .mutation(async ({ input, ctx }) => {
        try {
          await campaignService.cancel(input.campaignId, ctx.user!.id);
          return { success: true };
        } catch (error: unknown) {
          mapServiceError(error);
        }
      }),

    /**
     * Aggregate stats for the campaign detail page.
     */
    getStats: adminProcedure
      .input(getStatsInput)
      .query(async ({ input }) => {
        try {
          return await campaignService.getStats(input.campaignId);
        } catch (error: unknown) {
          mapServiceError(error);
        }
      }),

    /**
     * Recent CampaignSend rows for the detail page sends tab.
     */
    getRecentSends: adminProcedure
      .input(getRecentSendsInput)
      .query(async ({ input }) => {
        try {
          return await campaignService.getRecentSends(input.campaignId, input.take);
        } catch (error: unknown) {
          mapServiceError(error);
        }
      }),
  }),
});
