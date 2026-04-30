/**
 * Send Service — Per-Recipient Marketing Email Pipeline
 *
 * Executes a 10-step pipeline for each contact in a campaign:
 *   1.  Redis idempotency lock (NX, 24h TTL)
 *   2.  Suppression check
 *   3.  Consent verification
 *   4.  Generate unsubscribe token + URL (+ optional UTM)
 *   5.  Render template via registry
 *   6.  Build Resend payload
 *   7.  Call reactMailer.sendMarketingEmail()
 *   8.  Persist CampaignSend row
 *   9.  Write audit log
 *   10. Update Contact.lastEmailedAt
 *
 * NEVER throws from sendToContact() — all errors produce a typed result.
 * One failed contact must not abort the rest of the campaign.
 */

import React from 'react';
import { CampaignSendStatus, ContactConsentStatus, MarketingTemplateKey } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { appConfig } from '@/config/app.config';
import { generateSignedToken } from '@/lib/tokens/signed-token.util';
import { isSuppressed } from '@/modules/marketing/suppression.service';
import { maybeAppendUtm, FEATURE_FLAG_UTM_TRACKING } from '@/config/email-analytics.constants';
import { TEMPLATE_REGISTRY } from './template-registry';
import type { ContactWithCompany } from './list.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendCampaignToContactInput {
  campaignId:        string;
  contact:           ContactWithCompany;
  templateKey:       MarketingTemplateKey;
  templateVariables: Record<string, unknown>;
  campaignName:      string;
  subject:           string;
}

export interface SendCampaignToContactResult {
  status:        CampaignSendStatus;
  messageId?:    string;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

function idempotencyLockKey(campaignId: string, contactId: string): string {
  return `sheriabot:marketing:campaignsend:${campaignId}:${contactId}`;
}

// ---------------------------------------------------------------------------
// Audit log helper (non-fatal)
// ---------------------------------------------------------------------------

async function writeAuditLog(
  action:     string,
  entityType: string,
  entityId:   string,
  metadata?:  Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: { action, entityType, entityId, metadata: metadata as object },
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
// UTM feature flag check (cached in Redis for 5 min)
// ---------------------------------------------------------------------------

const UTM_FLAG_CACHE_KEY = `sheriabot:featureflag:${FEATURE_FLAG_UTM_TRACKING}`;
const UTM_FLAG_CACHE_TTL = 300; // 5 minutes

async function isUtmTrackingEnabled(): Promise<boolean> {
  try {
    const cached = await redis.get<string>(UTM_FLAG_CACHE_KEY);
    if (cached !== null) return cached === 'true';

    const flag = await prisma.featureFlag.findUnique({
      where:  { name: FEATURE_FLAG_UTM_TRACKING },
      select: { enabled: true },
    });
    const enabled = flag?.enabled ?? false;
    await redis.set(UTM_FLAG_CACHE_KEY, String(enabled), { ex: UTM_FLAG_CACHE_TTL });
    return enabled;
  } catch {
    return false; // fail-safe: no UTMs if flag check fails
  }
}

// ---------------------------------------------------------------------------
// SendService
// ---------------------------------------------------------------------------

export class SendService {
  /**
   * Execute the 10-step per-recipient send pipeline.
   * NEVER throws — all errors produce a typed SendCampaignToContactResult.
   */
  async sendToContact(
    input: SendCampaignToContactInput,
  ): Promise<SendCampaignToContactResult> {
    const { campaignId, contact, templateKey, templateVariables, campaignName, subject } = input;
    const contactId = contact.id;

    try {
      // ── Step 1: Redis idempotency lock ──────────────────────────────────
      const lockKey = idempotencyLockKey(campaignId, contactId);
      const lockAcquired = await redis.set(lockKey, '1', { ex: 86400, nx: true });

      if (lockAcquired === null) {
        // Lock already held — check if a CampaignSend row exists
        const existing = await prisma.campaignSend.findUnique({
          where:  { campaignId_contactId: { campaignId, contactId } },
          select: { status: true, messageId: true },
        });
        if (existing) {
          logger.info({ type: 'marketing_send_idempotency_skip', campaignId, contactId });
          return { status: existing.status, messageId: existing.messageId ?? undefined };
        }
        // Stale lock or race condition — log warning and proceed
        logger.warn({ type: 'marketing_send_stale_lock', campaignId, contactId });
      }

      // ── Step 2: Suppression check ────────────────────────────────────────
      const suppressed = await isSuppressed(contact.email);
      if (suppressed) {
        // Look up the reason for the suppressionReason column
        const suppressionRecord = await prisma.suppressionList.findUnique({
          where:  { email: contact.email.trim().toLowerCase() },
          select: { reason: true },
        });

        await prisma.$transaction([
          prisma.campaignSend.upsert({
            where:  { campaignId_contactId: { campaignId, contactId } },
            create: {
              campaignId,
              contactId,
              status:           CampaignSendStatus.SUPPRESSED_SKIPPED,
              suppressionReason: suppressionRecord?.reason ?? undefined,
            },
            update: {
              status:           CampaignSendStatus.SUPPRESSED_SKIPPED,
              suppressionReason: suppressionRecord?.reason ?? undefined,
            },
          }),
          prisma.marketingCampaign.update({
            where: { id: campaignId },
            data:  { totalSuppressedSkip: { increment: 1 } },
          }),
        ]);

        await writeAuditLog(
          'MARKETING_EMAIL_SUPPRESSION_SKIP',
          'CampaignSend',
          `${campaignId}:${contactId}`,
          { campaignId, contactId, reason: suppressionRecord?.reason },
        );

        return { status: CampaignSendStatus.SUPPRESSED_SKIPPED };
      }

      // ── Step 3: Consent verification ─────────────────────────────────────
      const consentOk =
        contact.consentStatus === ContactConsentStatus.GRANTED ||
        (contact.consentStatus === ContactConsentStatus.PENDING &&
          contact.consentSource === 'csv_import');

      if (!consentOk) {
        await prisma.$transaction([
          prisma.campaignSend.upsert({
            where:  { campaignId_contactId: { campaignId, contactId } },
            create: { campaignId, contactId, status: CampaignSendStatus.NO_CONSENT_SKIPPED },
            update: { status: CampaignSendStatus.NO_CONSENT_SKIPPED },
          }),
          prisma.marketingCampaign.update({
            where: { id: campaignId },
            data:  { totalNoConsentSkip: { increment: 1 } },
          }),
        ]);

        await writeAuditLog(
          'MARKETING_EMAIL_NO_CONSENT_SKIP',
          'CampaignSend',
          `${campaignId}:${contactId}`,
          { campaignId, contactId, consentStatus: contact.consentStatus },
        );

        return { status: CampaignSendStatus.NO_CONSENT_SKIPPED };
      }

      // ── Step 4: Generate unsubscribe token + URL ─────────────────────────
      const { publicToken, tokenHash } = generateSignedToken();
      const baseUnsubUrl = `${appConfig.marketing.appPublicUrl}/unsubscribe/${publicToken}`;
      const utmEnabled   = await isUtmTrackingEnabled();
      const unsubscribeUrl = maybeAppendUtm(baseUnsubUrl, campaignName, utmEnabled);

      // ── Step 5: Render template ──────────────────────────────────────────
      const registryEntry = TEMPLATE_REGISTRY[templateKey];
      let validatedVars: Record<string, unknown>;
      try {
        validatedVars = registryEntry.validateVars(templateVariables);
      } catch (validationErr: unknown) {
        const errMsg = validationErr instanceof Error
          ? validationErr.message
          : String(validationErr);

        await prisma.campaignSend.upsert({
          where:  { campaignId_contactId: { campaignId, contactId } },
          create: {
            campaignId,
            contactId,
            status:       CampaignSendStatus.FAILED,
            errorMessage: `Template variable validation failed: ${errMsg}`.slice(0, 500),
          },
          update: {
            status:       CampaignSendStatus.FAILED,
            errorMessage: `Template variable validation failed: ${errMsg}`.slice(0, 500),
          },
        });

        await writeAuditLog(
          'MARKETING_EMAIL_FAILED',
          'CampaignSend',
          `${campaignId}:${contactId}`,
          { campaignId, contactId, error: errMsg },
        );

        logger.error({ type: 'marketing_send_validation_failed', campaignId, contactId, error: errMsg });
        return { status: CampaignSendStatus.FAILED, errorMessage: errMsg };
      }

      // Merge pipeline-injected props with validated admin vars
      const templateProps = {
        ...validatedVars,
        recipientFirstName: contact.firstName ?? undefined,
        unsubscribeUrl,
      };

      // Build the React element — sendMarketingEmail renders it internally
      const emailElement = React.createElement(registryEntry.component, templateProps);

      // ── Steps 6 + 7: Build payload + send ───────────────────────────────
      // sendMarketingEmail handles render errors internally and returns { success: false }
      const sendResult = await reactMailer.sendMarketingEmail({
        to:             contact.email,
        subject,
        element:        emailElement,
        campaignId,
        contactId,
        unsubscribeUrl,
        additionalTags: [{ name: 'templateKey', value: templateKey.toLowerCase() }],
      });

      // ── Step 8: Persist CampaignSend row ─────────────────────────────────
      const now = new Date();

      if (sendResult.success) {
        // Step 10 (Contact.lastEmailedAt) is atomic with the CampaignSend write
        await prisma.$transaction([
          prisma.campaignSend.upsert({
            where:  { campaignId_contactId: { campaignId, contactId } },
            create: {
              campaignId,
              contactId,
              status:              CampaignSendStatus.SENT,
              messageId:           sendResult.messageId,
              unsubscribeTokenHash: tokenHash,
              sentAt:              now,
            },
            update: {
              status:              CampaignSendStatus.SENT,
              messageId:           sendResult.messageId,
              unsubscribeTokenHash: tokenHash,
              sentAt:              now,
            },
          }),
          prisma.contact.update({
            where: { id: contactId },
            data:  { lastEmailedAt: now },
          }),
          prisma.marketingCampaign.update({
            where: { id: campaignId },
            data:  { totalSent: { increment: 1 } },
          }),
        ]);

        // ── Step 9: Audit log (success) ──────────────────────────────────
        await writeAuditLog(
          'MARKETING_EMAIL_SENT',
          'CampaignSend',
          `${campaignId}:${contactId}`,
          { campaignId, contactId, messageId: sendResult.messageId },
        );

        logger.info({
          type:       'marketing_email_sent',
          campaignId,
          contactId,
          messageId:  sendResult.messageId,
        });

        return { status: CampaignSendStatus.SENT, messageId: sendResult.messageId };

      } else {
        const errMsg = (sendResult.error ?? 'Unknown send error').slice(0, 500);

        await prisma.campaignSend.upsert({
          where:  { campaignId_contactId: { campaignId, contactId } },
          create: {
            campaignId,
            contactId,
            status:       CampaignSendStatus.FAILED,
            errorMessage: errMsg,
          },
          update: {
            status:       CampaignSendStatus.FAILED,
            errorMessage: errMsg,
          },
        });

        // ── Step 9: Audit log (failure) ──────────────────────────────────
        await writeAuditLog(
          'MARKETING_EMAIL_FAILED',
          'CampaignSend',
          `${campaignId}:${contactId}`,
          { campaignId, contactId, error: errMsg },
        );

        logger.error({
          type:       'marketing_email_failed',
          campaignId,
          contactId,
          error:      errMsg,
        });

        return { status: CampaignSendStatus.FAILED, errorMessage: errMsg };
      }

    } catch (unexpectedErr: unknown) {
      // Catch-all: unexpected errors must not crash the campaign loop
      const errMsg = unexpectedErr instanceof Error
        ? unexpectedErr.message
        : String(unexpectedErr);

      logger.error({
        type:       'marketing_send_unexpected_error',
        campaignId,
        contactId,
        error:      errMsg,
      });

      try {
        await prisma.campaignSend.upsert({
          where:  { campaignId_contactId: { campaignId, contactId } },
          create: {
            campaignId,
            contactId,
            status:       CampaignSendStatus.FAILED,
            errorMessage: `Unexpected error: ${errMsg}`.slice(0, 500),
          },
          update: {
            status:       CampaignSendStatus.FAILED,
            errorMessage: `Unexpected error: ${errMsg}`.slice(0, 500),
          },
        });
      } catch {
        // If even the error persistence fails, just log — never throw
        logger.error({ type: 'marketing_send_persist_failed', campaignId, contactId });
      }

      return {
        status:       CampaignSendStatus.FAILED,
        errorMessage: errMsg,
      };
    }
  }
}

export const sendService = new SendService();
