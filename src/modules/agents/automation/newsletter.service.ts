import { TRPCError } from '@trpc/server';
import { MarketingCampaignStatus, MarketingTemplateKey } from '@prisma/client';
import { logger } from '@/utils/logger';
import { redis as defaultRedis } from '@/lib/redis/client';
import { campaignService as defaultCampaignService } from '@/modules/marketing/campaign.service';
import { TEMPLATE_REGISTRY } from '@/modules/marketing/template-registry';
import { automationApprovalService as defaultAutomationApprovalService, type AutomationApprovalService } from './approval.service';

export interface SendNewsletterInput {
  approvalId: string;
}

export interface SendNewsletterResult {
  campaignId: string;
  finalStatus: MarketingCampaignStatus;
  sent: number;
  skipped: number;
  failed: number;
}

type ApprovalServiceLike = Pick<AutomationApprovalService, 'getApproval' | 'requireMetadataField' | 'requireMetadataObjectField'>;
type CampaignServiceLike = Pick<typeof defaultCampaignService, 'create' | 'requestSendConfirmation' | 'executeSend' | 'getById'>;
type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ex?: number; nx?: boolean }): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

export interface AutomationNewsletterServiceDependencies {
  approvalService?: ApprovalServiceLike;
  campaignService?: CampaignServiceLike;
  redis?: RedisLike;
}

// In-flight mutex - guards the create-campaign -> confirm -> execute sequence
// against a concurrent duplicate call for the same approval. 5 minutes mirrors
// campaign.service.ts's own CONFIRM_TOKEN_TTL magnitude; the whole sequence
// below (sync send, or handing off to the async queue) completes well inside it.
const IN_PROGRESS_LOCK_TTL_SECONDS = 300;

// Completed-send marker - read on any later call for the same approval so a
// retried webhook replays the original result instead of creating a second
// MarketingCampaign and double-emailing every recipient. 90 days is long
// enough that no realistic n8n retry window survives past it; not literally
// permanent only to avoid unbounded key growth.
const SENT_MARKER_TTL_SECONDS = 60 * 60 * 24 * 90;

function inProgressLockKey(approvalId: string): string {
  return `sheriabot:automation:newsletter:lock:${approvalId}`;
}

function sentMarkerKey(approvalId: string): string {
  return `sheriabot:automation:newsletter:sent:${approvalId}`;
}

/**
 * Wires the approval gate to a real send via the existing templated
 * MarketingCampaign pipeline (Phase B decision: templated merge, not raw
 * HTML - see KenyanComplianceBriefEmail / template-registry.ts).
 *
 * Confirmation-equivalence bridge: campaign.service.ts's requestSendConfirmation
 * -> executeSend two-step flow only checks that the same identity string
 * confirms and executes (campaign.service.ts's "same admin" check) within the
 * token TTL - neither is session-derived, so calling both back-to-back here
 * with the approving human's own decidedBy user id satisfies that check
 * trivially and keeps a real person (not a system principal) as the audit
 * trail for a compliance-relevant send.
 */
export class AutomationNewsletterService {
  private readonly approvalService: ApprovalServiceLike;
  private readonly campaignService: CampaignServiceLike;
  private readonly redis: RedisLike;

  constructor(dependencies: AutomationNewsletterServiceDependencies = {}) {
    this.approvalService = dependencies.approvalService ?? defaultAutomationApprovalService;
    this.campaignService = dependencies.campaignService ?? defaultCampaignService;
    this.redis = dependencies.redis ?? defaultRedis;
  }

  async sendNewsletter(input: SendNewsletterInput): Promise<SendNewsletterResult> {
    const { approvalId } = input;

    const approval = await this.approvalService.getApproval({ approvalId });
    if (approval.status !== 'approved') {
      throw new TRPCError({ code: 'FORBIDDEN', message: `Approval ${approvalId} is not approved (status: ${approval.status}).` });
    }

    // Hard requirement, not a fallback: recordApprovalDecision always sets
    // decidedBy in the same update as status (approval.service.ts), so a null
    // value here on an approved row means an upstream invariant already broke.
    // Substituting a system principal would silently misattribute a
    // compliance-relevant send to a robot instead of the human who approved
    // it - fail loud instead.
    if (!approval.decidedBy) {
      logger.error({ type: 'automation_newsletter_missing_decided_by', approvalId });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Approval ${approvalId} is approved but has no decidedBy recorded. Refusing to attribute this send to a system principal - this indicates a data integrity issue upstream.`,
      });
    }
    const decidedBy = approval.decidedBy;

    const alreadySentCampaignId = await this.redis.get(sentMarkerKey(approvalId));
    if (alreadySentCampaignId) {
      logger.info({ type: 'automation_newsletter_idempotent_replay', approvalId, campaignId: alreadySentCampaignId });
      return this.replayResult(alreadySentCampaignId);
    }

    const lockKey = inProgressLockKey(approvalId);
    const acquired = await this.redis.set(lockKey, decidedBy, { ex: IN_PROGRESS_LOCK_TTL_SECONDS, nx: true });
    if (acquired === null) {
      logger.warn({ type: 'automation_newsletter_send_in_progress', approvalId });
      throw new TRPCError({ code: 'CONFLICT', message: `A send for approval ${approvalId} is already in progress. Retry shortly.` });
    }

    try {
      const listId = await this.approvalService.requireMetadataField(approvalId, 'listId');
      const subject = await this.approvalService.requireMetadataField(approvalId, 'subject');
      const rawTemplateVariables = await this.approvalService.requireMetadataObjectField(approvalId, 'templateVariables');

      let templateVariables: Record<string, unknown>;
      try {
        templateVariables = TEMPLATE_REGISTRY[MarketingTemplateKey.KENYAN_COMPLIANCE_BRIEF].validateVars(rawTemplateVariables);
      } catch (validationErr: unknown) {
        const message = validationErr instanceof Error ? validationErr.message : String(validationErr);
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Newsletter templateVariables failed validation: ${message}` });
      }

      const editionLabel = typeof templateVariables.editionLabel === 'string' ? templateVariables.editionLabel : approvalId;

      const campaign = await this.campaignService.create({
        name: `The Kenyan Compliance Brief - ${editionLabel}`,
        subject,
        templateKey: MarketingTemplateKey.KENYAN_COMPLIANCE_BRIEF,
        templateVariables,
        listId,
        createdById: decidedBy,
      });

      const confirmation = await this.campaignService.requestSendConfirmation({
        campaignId: campaign.id,
        requestedById: decidedBy,
      });

      const result = await this.campaignService.executeSend({
        campaignId: campaign.id,
        confirmationToken: confirmation.confirmationToken,
        confirmedRecipientCount: confirmation.recipientCount,
        executedById: decidedBy,
      });

      await this.redis.set(sentMarkerKey(approvalId), campaign.id, { ex: SENT_MARKER_TTL_SECONDS });

      logger.info({
        type: 'automation_newsletter_sent',
        approvalId,
        campaignId: campaign.id,
        decidedBy,
        finalStatus: result.finalStatus,
      });

      return {
        campaignId: campaign.id,
        finalStatus: result.finalStatus,
        sent: result.sent,
        skipped: result.skipped,
        failed: result.failed,
      };
    } catch (error: unknown) {
      logger.error({
        type: 'automation_newsletter_send_failed',
        approvalId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      await this.redis.del(lockKey);
    }
  }

  private async replayResult(campaignId: string): Promise<SendNewsletterResult> {
    const campaign = await this.campaignService.getById(campaignId);
    if (!campaign) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `Previously-sent campaign ${campaignId} no longer exists.` });
    }
    return {
      campaignId: campaign.id,
      finalStatus: campaign.status,
      sent: campaign.totalSent,
      skipped: campaign.totalSuppressedSkip + campaign.totalNoConsentSkip,
      failed: campaign.totalFailed,
    };
  }
}

export const automationNewsletterService = new AutomationNewsletterService();
