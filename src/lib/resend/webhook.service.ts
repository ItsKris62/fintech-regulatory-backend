/**
 * Resend Webhook Service
 *
 * Public API (two-phase, matches Fastify route pattern in app.ts):
 *   1. verifyAndParse()        — synchronous; validates Svix signature + timestamp,
 *                                JSON-parses the body. Returns a discriminated union.
 *                                Route sends 200 immediately after this returns valid.
 *   2. processEventBackground() — async; idempotency check + all DB writes.
 *                                 Wrapped in a top-level try/catch; never rethrows.
 *                                 Called fire-and-forget from the route.
 *
 * Handled event types:
 *   email.sent        → SENT
 *   email.delivered   → DELIVERED  (deliveredAt)
 *   email.opened      → OPENED     (openedAt — first occurrence only)
 *   email.clicked     → CLICKED    (firstClickedAt — first occurrence only)
 *   email.bounced     → BOUNCED
 *     hard bounce → SuppressionList (BOUNCED) + Contact.suppressedAt/suppressedReason
 *                   consentStatus is NOT changed (bounce is operational, not consent withdrawal)
 *     soft bounce → EmailEvent only; no suppression, no contact update
 *   email.complained  → COMPLAINED → SuppressionList (COMPLAINED) + Contact.suppressedAt +
 *                                    suppressedReason + consentStatus = REVOKED
 *
 * Idempotency: Redis SET NX on `sheriabot:resend:evt:{messageId}:{eventType}` (30-day TTL).
 */

import * as crypto from 'node:crypto';
import {
  EmailEventType,
  CampaignSendStatus,
  SuppressionReason,
  ContactConsentStatus,
} from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { appConfig } from '@/config/app.config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResendEmailData {
  email_id: string;
  from?: string;
  to?: string[];
  subject?: string;
  created_at?: string;
  click?: {
    link: string;
    timestamp: string;
    ipAddress?: string;
    userAgent?: string;
  };
  bounce?: {
    message: string;
    type?: string;    // "hard" | "soft" — used to gate suppression
    subtype?: string;
  };
}

interface ResendWebhookPayload {
  type: string;
  created_at: string;
  data: ResendEmailData;
}

// Discriminated union returned by verifyAndParse
export type VerifyAndParseResult =
  | {
      valid: true;
      payload: ResendWebhookPayload;
      eventType: EmailEventType | null;  // null for unrecognised event types
      messageId: string | null;          // null if data.email_id absent
    }
  | {
      valid: false;
      reason: 'invalid_signature' | 'invalid_timestamp' | 'malformed_payload';
    };

// CampaignSend columns needed for event processing
interface CampaignSendRow {
  id: string;
  contactId: string;
  openedAt: Date | null;
  firstClickedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDEMPOTENCY_TTL = 60 * 60 * 24 * 30; // 30 days
const TIMESTAMP_TOLERANCE_SECONDS = 300;    // 5-minute window (Svix default)

const RESEND_TO_EVENT_TYPE: Record<string, EmailEventType> = {
  'email.sent':       EmailEventType.SENT,
  'email.delivered':  EmailEventType.DELIVERED,
  'email.opened':     EmailEventType.OPENED,
  'email.clicked':    EmailEventType.CLICKED,
  'email.bounced':    EmailEventType.BOUNCED,
  'email.complained': EmailEventType.COMPLAINED,
};

// ---------------------------------------------------------------------------
// Svix signature verification (manual — no svix npm package)
// Internal helper; throws on failure so verifyAndParse can catch + map reasons.
// ---------------------------------------------------------------------------

function verifySvixSignature(
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  rawBody: Buffer,
): void {
  const ts = parseInt(svixTimestamp, 10);
  if (isNaN(ts)) throw new Error('invalid_timestamp: non-numeric svix-timestamp');

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - ts) > TIMESTAMP_TOLERANCE_SECONDS) {
    throw new Error('invalid_timestamp: outside tolerance window');
  }

  // Resend provides the secret as "whsec_<base64>" or as a raw string
  const rawSecret = appConfig.marketing.webhookSecret;
  const signingKey = rawSecret.startsWith('whsec_')
    ? Buffer.from(rawSecret.slice(6), 'base64')
    : Buffer.from(rawSecret, 'utf-8');

  // Svix signed content: "{svix-id}.{svix-timestamp}.{body}"
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody.toString('utf-8')}`;

  const expected = crypto
    .createHmac('sha256', signingKey)
    .update(signedContent)
    .digest('base64');

  // svix-signature may contain multiple space-separated "v1,<base64>" entries
  const signatures = svixSignature.split(' ').filter(Boolean);

  const matched = signatures.some((entry) => {
    const commaIdx = entry.indexOf(',');
    if (commaIdx === -1) return false;
    const version = entry.slice(0, commaIdx);
    const value   = entry.slice(commaIdx + 1);
    if (version !== 'v1' || !value) return false;

    try {
      const expectedBuf = Buffer.from(expected, 'base64');
      const actualBuf   = Buffer.from(value, 'base64');
      if (expectedBuf.length !== actualBuf.length) return false;
      return crypto.timingSafeEqual(expectedBuf, actualBuf);
    } catch {
      return false;
    }
  });

  if (!matched) throw new Error('invalid_signature: HMAC mismatch');
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

class ResendWebhookService {
  // -------------------------------------------------------------------------
  // Phase A — synchronous verification (fast; call before sending HTTP 200)
  // -------------------------------------------------------------------------

  verifyAndParse(
    rawBody: Buffer,
    svixId: string,
    svixTimestamp: string,
    svixSignature: string,
  ): VerifyAndParseResult {
    try {
      verifySvixSignature(svixId, svixTimestamp, svixSignature, rawBody);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      if (message.startsWith('invalid_timestamp')) {
        return { valid: false, reason: 'invalid_timestamp' };
      }
      return { valid: false, reason: 'invalid_signature' };
    }

    let payload: ResendWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf-8')) as ResendWebhookPayload;
    } catch {
      return { valid: false, reason: 'malformed_payload' };
    }

    const eventType = RESEND_TO_EVENT_TYPE[payload.type] ?? null;
    const messageId = payload.data?.email_id ?? null;

    return { valid: true, payload, eventType, messageId };
  }

  // -------------------------------------------------------------------------
  // Phase B — async processing (fire-and-forget; call after HTTP 200 is sent)
  // -------------------------------------------------------------------------

  async processEventBackground(
    payload: ResendWebhookPayload,
    eventType: EmailEventType | null,
    messageId: string | null,
  ): Promise<void> {
    try {
      if (!eventType) {
        logger.debug({ type: 'resend_webhook_unhandled', resendType: payload.type });
        return;
      }
      if (!messageId) {
        logger.warn({ type: 'resend_webhook_missing_email_id', resendType: payload.type });
        return;
      }

      const alreadyProcessed = await this.markProcessed(messageId, eventType);
      if (alreadyProcessed) {
        logger.info({ type: 'resend_webhook_duplicate_skipped', messageId, eventType });
        return;
      }

      logger.info({ type: 'resend_webhook_received', resendType: payload.type, messageId });

      await this.processEvent(payload, eventType, messageId);
    } catch (err: unknown) {
      // Errors are logged but not rethrown — the .catch() in app.ts is a secondary safety net
      logger.error({
        type:      'resend_webhook_processing_error',
        messageId,
        eventType,
        error:     err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Event dispatch (private)
  // ---------------------------------------------------------------------------

  private async processEvent(
    payload: ResendWebhookPayload,
    eventType: EmailEventType,
    messageId: string,
  ): Promise<void> {
    const occurredAt     = new Date(payload.created_at);
    const recipientEmail = payload.data.to?.[0] ?? null;

    const send = await prisma.campaignSend.findFirst({
      where:  { messageId },
      select: { id: true, contactId: true, openedAt: true, firstClickedAt: true },
    });

    await prisma.emailEvent.create({
      data: {
        messageId,
        eventType,
        occurredAt,
        eventData: payload as object,
        ...(send ? { sendId: send.id } : {}),
      },
    });

    switch (eventType) {
      case EmailEventType.SENT:
        await this.handleSent(send);
        break;
      case EmailEventType.DELIVERED:
        await this.handleDelivered(send, occurredAt);
        break;
      case EmailEventType.OPENED:
        await this.handleOpened(send, occurredAt);
        break;
      case EmailEventType.CLICKED:
        await this.handleClicked(send, occurredAt);
        break;
      case EmailEventType.BOUNCED:
        await this.handleBounced(send, recipientEmail, occurredAt, payload.data);
        break;
      case EmailEventType.COMPLAINED:
        await this.handleComplained(send, recipientEmail, occurredAt);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Per-event handlers
  // ---------------------------------------------------------------------------

  private async handleSent(send: CampaignSendRow | null): Promise<void> {
    if (!send) return;
    await prisma.campaignSend.update({
      where: { id: send.id },
      data:  { status: CampaignSendStatus.SENT },
    });
  }

  private async handleDelivered(send: CampaignSendRow | null, occurredAt: Date): Promise<void> {
    if (!send) return;
    await prisma.campaignSend.update({
      where: { id: send.id },
      data:  { status: CampaignSendStatus.DELIVERED, deliveredAt: occurredAt },
    });
  }

  private async handleOpened(send: CampaignSendRow | null, occurredAt: Date): Promise<void> {
    if (!send) return;
    await prisma.campaignSend.update({
      where: { id: send.id },
      data:  {
        status:   CampaignSendStatus.OPENED,
        openedAt: send.openedAt ?? occurredAt, // preserve first-open time
      },
    });
  }

  private async handleClicked(send: CampaignSendRow | null, occurredAt: Date): Promise<void> {
    if (!send) return;
    await prisma.campaignSend.update({
      where: { id: send.id },
      data:  {
        status:         CampaignSendStatus.CLICKED,
        firstClickedAt: send.firstClickedAt ?? occurredAt,
      },
    });
  }

  private async handleBounced(
    send: CampaignSendRow | null,
    recipientEmail: string | null,
    occurredAt: Date,
    data: ResendEmailData,
  ): Promise<void> {
    const bounceMessage = data.bounce?.message ?? 'Bounce recorded by Resend';
    const isHardBounce  = data.bounce?.type === 'hard';

    if (send) {
      await prisma.campaignSend.update({
        where: { id: send.id },
        data:  {
          status:       CampaignSendStatus.BOUNCED,
          bouncedAt:    occurredAt,
          errorMessage: bounceMessage,
        },
      });
    }

    // Soft bounces are tracked in EmailEvent only — no suppression
    if (!isHardBounce) {
      logger.info({ type: 'resend_soft_bounce_tracked', occurredAt: occurredAt.toISOString() });
      return;
    }

    const email = recipientEmail ?? (send ? await this.emailFromSend(send) : null);
    if (email) {
      await this.upsertSuppression(email, SuppressionReason.BOUNCED);
      await this.markContactSuppressed(email, SuppressionReason.BOUNCED, send?.contactId);
    }

    logger.info({
      type:       'resend_hard_bounce_suppressed',
      email,
      occurredAt: occurredAt.toISOString(),
    });
  }

  private async handleComplained(
    send: CampaignSendRow | null,
    recipientEmail: string | null,
    occurredAt: Date,
  ): Promise<void> {
    const email = recipientEmail ?? (send ? await this.emailFromSend(send) : null);

    if (send) {
      await prisma.campaignSend.update({
        where: { id: send.id },
        data:  {
          status:       CampaignSendStatus.COMPLAINED,
          complainedAt: occurredAt,
          errorMessage: 'Spam complaint',
        },
      });
    }

    if (email) {
      await this.upsertSuppression(email, SuppressionReason.COMPLAINED);
      await this.markContactSuppressed(email, SuppressionReason.COMPLAINED, send?.contactId);
    }

    logger.info({
      type:       'resend_spam_complaint_suppressed',
      email,
      occurredAt: occurredAt.toISOString(),
    });
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  /**
   * Atomically mark an event as processed (Redis SET NX).
   * Returns true if already processed (duplicate), false if new.
   * Fails open on Redis error so events are never silently dropped.
   */
  private async markProcessed(messageId: string, eventType: EmailEventType): Promise<boolean> {
    try {
      const key    = `sheriabot:resend:evt:${messageId}:${eventType}`;
      const result = await redis.set(key, '1', { ex: IDEMPOTENCY_TTL, nx: true });
      return result === null; // null = key existed = duplicate
    } catch (err: unknown) {
      logger.warn({
        type:      'resend_webhook_idempotency_failed',
        messageId,
        eventType,
        error:     err instanceof Error ? err.message : String(err),
      });
      return false; // Fail open — process rather than silently drop
    }
  }

  /** Idempotent suppression upsert — email is unique in the table. */
  private async upsertSuppression(email: string, reason: SuppressionReason): Promise<void> {
    await prisma.suppressionList.upsert({
      where:  { email },
      create: { email, reason },
      update: {},
    });
  }

  /**
   * Update Contact suppression fields with bounce/complaint-aware semantics:
   *
   * - BOUNCED:    set suppressedAt + suppressedReason only.
   *               consentStatus is NOT changed — a hard bounce is an operational
   *               fact (mailbox doesn't exist), not a deliberate consent withdrawal.
   *
   * - COMPLAINED: set suppressedAt + suppressedReason + consentStatus = REVOKED.
   *               A spam report IS a deliberate consent withdrawal.
   *
   * - UNSUBSCRIBED (future): same as COMPLAINED.
   *
   * Uses updateMany for both paths to avoid P2025 if the contact was deleted
   * between event arrival and processing time.
   */
  private async markContactSuppressed(
    email: string,
    reason: SuppressionReason,
    contactId?: string,
  ): Promise<void> {
    const now = new Date();

    const revokesConsent =
      reason === SuppressionReason.COMPLAINED ||
      reason === SuppressionReason.UNSUBSCRIBED;

    const updateData: {
      suppressedAt: Date;
      suppressedReason: SuppressionReason;
      consentStatus?: ContactConsentStatus;
    } = {
      suppressedAt:    now,
      suppressedReason: reason,
    };

    if (revokesConsent) {
      updateData.consentStatus = ContactConsentStatus.REVOKED;
    }

    if (contactId) {
      await prisma.contact.updateMany({
        where: { id: contactId, deletedAt: null },
        data:  updateData,
      });
      return;
    }

    await prisma.contact.updateMany({
      where: { email, deletedAt: null },
      data:  updateData,
    });
  }

  /** Resolve the recipient email from CampaignSend → Contact. */
  private async emailFromSend(send: CampaignSendRow): Promise<string | null> {
    const contact = await prisma.contact.findUnique({
      where:  { id: send.contactId },
      select: { email: true },
    });
    return contact?.email ?? null;
  }
}

export const resendWebhookService = new ResendWebhookService();
