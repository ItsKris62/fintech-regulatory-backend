/**
 * Campaign Service — Marketing Campaign Lifecycle + 2-Step Send Confirmation
 *
 * Manages the full lifecycle of a MarketingCampaign:
 *   - CRUD (create, getById, list, update, delete)
 *   - 2-step send confirmation (requestSendConfirmation → executeSend)
 *   - Campaign cancellation
 *   - Stats query for the admin detail page
 *
 * 2-step send flow:
 *   1. requestSendConfirmation — resolves recipients, enforces 25-cap,
 *      stores a short-lived Redis token, returns preview data to the UI.
 *   2. executeSend — validates the token, re-resolves recipients, iterates
 *      sequentially (NOT Promise.all), aggregates results, transitions status.
 *
 * The 25-recipient cap is enforced at BOTH steps (defense in depth).
 *
 * Audit actions:
 *   MARKETING_CAMPAIGN_CREATED | MARKETING_CAMPAIGN_UPDATED |
 *   MARKETING_CAMPAIGN_DELETED | MARKETING_CAMPAIGN_SENT |
 *   MARKETING_CAMPAIGN_CANCELLED
 */

import crypto from 'node:crypto';
import {
  CampaignSendStatus,
  MarketingCampaign,
  MarketingCampaignStatus,
  MarketingTemplateKey,
} from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { BadRequestError, NotFoundError } from '@/utils/error';
import { resolveContacts } from './list.service';
import { sendService } from './send.service';
import { sendQueueService } from './send-queue.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Threshold above which sends are routed to the async queue. */
const ASYNC_SEND_THRESHOLD = 25;

/** Redis TTL for send-confirmation tokens (5 minutes). */
const CONFIRM_TOKEN_TTL = 300;

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class RecipientLimitError extends BadRequestError {
  constructor(
    public readonly recipientCount: number,
    public readonly limit: number,
  ) {
    super(
      `This campaign has ${recipientCount} recipients but the v1 limit is ${limit}. ` +
      `Split the list into smaller segments or wait for B3 async support.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateCampaignInput {
  name:              string;
  subject:           string;
  templateKey:       MarketingTemplateKey;
  templateVariables: Record<string, unknown>;
  listId:            string;
  createdById:       string;
}

export interface UpdateCampaignInput {
  name?:              string;
  subject?:           string;
  templateVariables?: Record<string, unknown>;
  listId?:            string;
  scheduledFor?:      Date | null;
}

export interface CampaignListFilter {
  status?:      MarketingCampaignStatus;
  createdById?: string;
  take?:        number;
  skip?:        number;
}

export interface CampaignStats {
  campaignId:         string;
  totalRecipients:    number;
  totalSent:          number;
  totalDelivered:     number;
  totalOpened:        number;
  totalClicked:       number;
  totalBounced:       number;
  totalUnsubscribed:  number;
  totalComplained:    number;
  totalSuppressedSkip: number;
  totalNoConsentSkip: number;
  totalFailed:        number;
  sendsByStatus:      Record<string, number>;
}

interface ConfirmationTokenPayload {
  token:          string;
  recipientCount: number;
  requestedById:  string;
}

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

function confirmTokenKey(campaignId: string): string {
  return `sheriabot:marketing:sendconfirm:${campaignId}`;
}

// ---------------------------------------------------------------------------
// Audit log helper (non-fatal)
// ---------------------------------------------------------------------------

async function writeAuditLog(
  userId:     string,
  action:     string,
  entityType: string,
  entityId:   string,
  metadata?:  Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: { userId, action, entityType, entityId, metadata: metadata as object },
    });
  } catch (err: unknown) {
    logger.error({
      type:     'audit_log_write_failed',
      action,
      entityId,
      error:    err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// CampaignService
// ---------------------------------------------------------------------------

export class CampaignService {
  // ── CRUD ──────────────────────────────────────────────────────────────────

  async create(input: CreateCampaignInput): Promise<MarketingCampaign> {
    const campaign = await prisma.marketingCampaign.create({
      data: {
        name:              input.name.trim(),
        subject:           input.subject.trim(),
        templateKey:       input.templateKey,
        templateVariables: input.templateVariables,
        listId:            input.listId,
        createdById:       input.createdById,
      },
    });

    await writeAuditLog(
      input.createdById,
      'MARKETING_CAMPAIGN_CREATED',
      'MarketingCampaign',
      campaign.id,
      { name: campaign.name, templateKey: campaign.templateKey },
    );

    logger.info({ type: 'marketing_campaign_created', campaignId: campaign.id });
    return campaign;
  }

  async getById(id: string): Promise<MarketingCampaign | null> {
    return prisma.marketingCampaign.findUnique({
      where: { id },
    });
  }

  async list(filter: CampaignListFilter): Promise<{ items: MarketingCampaign[]; total: number }> {
    const where = {
      ...(filter.status      ? { status:      filter.status }      : {}),
      ...(filter.createdById ? { createdById: filter.createdById } : {}),
    };

    const [items, total] = await prisma.$transaction([
      prisma.marketingCampaign.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take:    filter.take ?? 20,
        skip:    filter.skip ?? 0,
      }),
      prisma.marketingCampaign.count({ where }),
    ]);

    return { items, total };
  }

  async update(
    id:          string,
    input:       UpdateCampaignInput,
    updatedById: string,
  ): Promise<MarketingCampaign> {
    const existing = await this.requireCampaign(id);

    if (
      existing.status !== MarketingCampaignStatus.DRAFT &&
      existing.status !== MarketingCampaignStatus.SCHEDULED
    ) {
      throw new BadRequestError(
        `Campaign cannot be updated in status '${existing.status}'. Only DRAFT or SCHEDULED campaigns can be edited.`,
      );
    }

    const campaign = await prisma.marketingCampaign.update({
      where: { id },
      data: {
        ...(input.name              !== undefined ? { name:              input.name.trim()        } : {}),
        ...(input.subject           !== undefined ? { subject:           input.subject.trim()     } : {}),
        ...(input.templateVariables !== undefined ? { templateVariables: input.templateVariables  } : {}),
        ...(input.listId            !== undefined ? { listId:            input.listId             } : {}),
        ...(input.scheduledFor      !== undefined ? { scheduledFor:      input.scheduledFor       } : {}),
      },
    });

    await writeAuditLog(
      updatedById,
      'MARKETING_CAMPAIGN_UPDATED',
      'MarketingCampaign',
      id,
      { updatedFields: Object.keys(input) },
    );

    return campaign;
  }

  async delete(id: string, deletedById: string): Promise<void> {
    const existing = await this.requireCampaign(id);

    if (existing.status === MarketingCampaignStatus.SENDING) {
      throw new BadRequestError('Cannot delete a campaign that is currently sending.');
    }

    await prisma.marketingCampaign.delete({ where: { id } });

    await writeAuditLog(
      deletedById,
      'MARKETING_CAMPAIGN_DELETED',
      'MarketingCampaign',
      id,
      { name: existing.name },
    );
  }

  // ── 2-Step Send: Step 1 ───────────────────────────────────────────────────

  async requestSendConfirmation(input: {
    campaignId:    string;
    requestedById: string;
  }): Promise<{
    confirmationToken:        string;
    recipientCount:           number;
    estimatedDurationSeconds: number;
    expiresAt:                Date;
    isAsync:                  boolean;
  }> {
    const campaign = await this.requireCampaign(input.campaignId);

    if (
      campaign.status !== MarketingCampaignStatus.DRAFT &&
      campaign.status !== MarketingCampaignStatus.SCHEDULED
    ) {
      throw new BadRequestError(
        `Campaign is in status '${campaign.status}'. Only DRAFT or SCHEDULED campaigns can be sent.`,
      );
    }

    if (!campaign.listId) {
      throw new BadRequestError('Campaign has no list assigned. Assign a contact list before sending.');
    }

    // Resolve recipients (applies consent + suppression filters)
    const contacts = await resolveContacts(campaign.listId);
    const recipientCount = contacts.length;

    // B3: No hard cap — async queue handles large lists
    const isAsync = recipientCount > ASYNC_SEND_THRESHOLD;

    // Generate confirmation token
    const confirmationToken = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + CONFIRM_TOKEN_TTL * 1000);

    const payload: ConfirmationTokenPayload = {
      token:          confirmationToken,
      recipientCount,
      requestedById:  input.requestedById,
    };

    await redis.set(
      confirmTokenKey(input.campaignId),
      JSON.stringify(payload),
      { ex: CONFIRM_TOKEN_TTL },
    );

    logger.info({
      type:          'marketing_send_confirmation_requested',
      campaignId:    input.campaignId,
      recipientCount,
      isAsync,
    });

    return {
      confirmationToken,
      recipientCount,
      estimatedDurationSeconds: isAsync ? 0 : recipientCount * 2,
      expiresAt,
      isAsync,
    };
  }

  // ── 2-Step Send: Step 2 ───────────────────────────────────────────────────

  async executeSend(input: {
    campaignId:              string;
    confirmationToken:       string;
    confirmedRecipientCount: number;
    executedById:            string;
  }): Promise<{
    campaignId:  string;
    finalStatus: MarketingCampaignStatus;
    sent:        number;
    skipped:     number;
    failed:      number;
  }> {
    const campaign = await this.requireCampaign(input.campaignId);

    // ── Validate confirmation token ──────────────────────────────────────
    const raw = await redis.get<string>(confirmTokenKey(input.campaignId));
    if (!raw) {
      throw new BadRequestError(
        'Send confirmation token has expired or was not found. Please re-confirm.',
      );
    }

    const payload = JSON.parse(raw) as ConfirmationTokenPayload;

    if (payload.token !== input.confirmationToken) {
      throw new BadRequestError('Invalid confirmation token.');
    }

    if (payload.requestedById !== input.executedById) {
      throw new BadRequestError(
        'The admin who confirmed the send must be the same admin who executes it.',
      );
    }

    if (payload.recipientCount !== input.confirmedRecipientCount) {
      throw new BadRequestError(
        'Recipient list changed since confirmation. Please re-confirm.',
      );
    }

    // ── Atomic status transition: DRAFT/SCHEDULED → SENDING ─────────────
    if (
      campaign.status !== MarketingCampaignStatus.DRAFT &&
      campaign.status !== MarketingCampaignStatus.SCHEDULED
    ) {
      throw new BadRequestError(
        `Campaign is in status '${campaign.status}'. Cannot execute send.`,
      );
    }

    const now = new Date();
    await prisma.marketingCampaign.update({
      where: { id: input.campaignId },
      data: {
        status:          MarketingCampaignStatus.SENDING,
        totalRecipients: payload.recipientCount,
        sentAt:          now,
      },
    });

    // ── Re-resolve recipients (defense in depth) ─────────────────────────
    if (!campaign.listId) {
      throw new BadRequestError('Campaign has no list assigned.');
    }

    const contacts = await resolveContacts(campaign.listId);

    // Verify count still matches what was confirmed
    if (contacts.length !== payload.recipientCount) {
      await prisma.marketingCampaign.update({
        where: { id: input.campaignId },
        data:  { status: MarketingCampaignStatus.DRAFT, sentAt: null, totalRecipients: 0 },
      });
      throw new BadRequestError(
        `Recipient count changed from ${payload.recipientCount} to ${contacts.length} since confirmation. Please re-confirm.`,
      );
    }

    // ── Route: async (>25) vs sync (≤25) ────────────────────────────────
    if (contacts.length > ASYNC_SEND_THRESHOLD) {
      // Async path: enqueue to Redis, return immediately
      const contactIds = contacts.map((c) => c.id);
      await sendQueueService.enqueue(input.campaignId, contactIds);

      // Delete confirmation token
      await redis.del(confirmTokenKey(input.campaignId));

      await writeAuditLog(
        input.executedById,
        'MARKETING_CAMPAIGN_SENT',
        'MarketingCampaign',
        input.campaignId,
        { mode: 'async', queued: contactIds.length },
      );

      return {
        campaignId:  input.campaignId,
        finalStatus: MarketingCampaignStatus.SENDING,
        sent:        0,
        skipped:     0,
        failed:      0,
      };
    }

    // ── Sequential send loop (≤25 contacts) ─────────────────────────────
    let sentCount    = 0;
    let skippedCount = 0;
    let failedCount  = 0;

    const templateVariables = campaign.templateVariables as Record<string, unknown>;

    for (const contact of contacts) {
      const result = await sendService.sendToContact({
        campaignId:        input.campaignId,
        contact,
        templateKey:       campaign.templateKey,
        templateVariables,
        campaignName:      campaign.name,
        subject:           campaign.subject,
      });

      switch (result.status) {
        case CampaignSendStatus.SENT:
          sentCount++;
          break;
        case CampaignSendStatus.SUPPRESSED_SKIPPED:
        case CampaignSendStatus.NO_CONSENT_SKIPPED:
          skippedCount++;
          break;
        default:
          failedCount++;
      }
    }

    // ── Determine final status ───────────────────────────────────────────
    let finalStatus: MarketingCampaignStatus;
    if (sentCount > 0 && failedCount === 0) {
      finalStatus = MarketingCampaignStatus.SENT;
    } else if (sentCount > 0 && failedCount > 0) {
      finalStatus = MarketingCampaignStatus.PARTIALLY_SENT;
    } else if (sentCount === 0 && failedCount > 0) {
      finalStatus = MarketingCampaignStatus.FAILED;
    } else {
      // All skipped (suppressed/no-consent) — treat as SENT (no failures)
      finalStatus = MarketingCampaignStatus.SENT;
    }

    const errorMessage =
      finalStatus === MarketingCampaignStatus.FAILED ? 'All sends failed' : undefined;

    await prisma.marketingCampaign.update({
      where: { id: input.campaignId },
      data: {
        status:       finalStatus,
        errorMessage: errorMessage ?? null,
      },
    });

    // ── Delete confirmation token ────────────────────────────────────────
    await redis.del(confirmTokenKey(input.campaignId));

    // ── Audit log ────────────────────────────────────────────────────────
    await writeAuditLog(
      input.executedById,
      'MARKETING_CAMPAIGN_SENT',
      'MarketingCampaign',
      input.campaignId,
      {
        finalStatus,
        sent:    sentCount,
        skipped: skippedCount,
        failed:  failedCount,
        total:   contacts.length,
      },
    );

    logger.info({
      type:        'marketing_campaign_sent',
      campaignId:  input.campaignId,
      finalStatus,
      sent:        sentCount,
      skipped:     skippedCount,
      failed:      failedCount,
    });

    return {
      campaignId:  input.campaignId,
      finalStatus,
      sent:        sentCount,
      skipped:     skippedCount,
      failed:      failedCount,
    };
  }

  // ── Cancel ────────────────────────────────────────────────────────────────

  async cancel(campaignId: string, cancelledById: string): Promise<void> {
    const campaign = await this.requireCampaign(campaignId);

    if (
      campaign.status !== MarketingCampaignStatus.DRAFT &&
      campaign.status !== MarketingCampaignStatus.SCHEDULED
    ) {
      throw new BadRequestError(
        `Campaign cannot be cancelled in status '${campaign.status}'. Only DRAFT or SCHEDULED campaigns can be cancelled.`,
      );
    }

    await prisma.marketingCampaign.update({
      where: { id: campaignId },
      data:  { status: MarketingCampaignStatus.CANCELLED },
    });

    // Clean up any pending confirmation token
    await redis.del(confirmTokenKey(campaignId));

    await writeAuditLog(
      cancelledById,
      'MARKETING_CAMPAIGN_CANCELLED',
      'MarketingCampaign',
      campaignId,
      { previousStatus: campaign.status },
    );

    logger.info({ type: 'marketing_campaign_cancelled', campaignId });
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  async getStats(campaignId: string): Promise<CampaignStats> {
    const campaign = await this.requireCampaign(campaignId);

    // Group CampaignSend rows by status in a single query
    const sendGroups = await prisma.campaignSend.groupBy({
      by:    ['status'],
      where: { campaignId },
      _count: { status: true },
    });

    const sendsByStatus: Record<string, number> = {};
    for (const group of sendGroups) {
      sendsByStatus[group.status] = group._count.status;
    }

    return {
      campaignId,
      totalRecipients:    campaign.totalRecipients,
      totalSent:          campaign.totalSent,
      totalDelivered:     campaign.totalDelivered,
      totalOpened:        campaign.totalOpened,
      totalClicked:       campaign.totalClicked,
      totalBounced:       campaign.totalBounced,
      totalUnsubscribed:  campaign.totalUnsubscribed,
      totalComplained:    campaign.totalComplained,
      totalSuppressedSkip: campaign.totalSuppressedSkip,
      totalNoConsentSkip: campaign.totalNoConsentSkip,
      totalFailed:        campaign.totalFailed,
      sendsByStatus,
    };
  }

  // ── Recent sends (for detail page) ───────────────────────────────────────

  async getRecentSends(campaignId: string, take = 50) {
    return prisma.campaignSend.findMany({
      where:   { campaignId },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id:               true,
        contactId:        true,
        status:           true,
        messageId:        true,
        sentAt:           true,
        errorMessage:     true,
        suppressionReason: true,
        contact: {
          select: {
            firstName: true,
            lastName:  true,
            email:     true,
          },
        },
      },
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async requireCampaign(id: string): Promise<MarketingCampaign> {
    const campaign = await prisma.marketingCampaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundError(`Campaign '${id}' not found`);
    return campaign;
  }
}

export const campaignService = new CampaignService();
