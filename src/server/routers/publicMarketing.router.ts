/**
 * Public Marketing Router - Phase B4
 *
 * Unauthenticated procedures for:
 *   - Unsubscribe token validation
 *   - Unsubscribe confirmation
 *   - Pilot programme application
 */

import { z } from "zod";
import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../trpc/trpc";
import { prisma } from "@/lib/prisma/client";
import { redis } from "@/lib/redis/client";
import { rateLimiter } from "@/lib/redis/rate-limiter";
import { logger } from "@/utils/logger";
import { hashIp } from "@/utils/request-identifiers";
import { rateLimited } from "../trpc/middleware";
import { isSuppressed, suppress } from "@/modules/marketing/suppression.service";
import { recordConsent } from "@/modules/marketing/consent.service";
import { createContact, updateContact } from "@/modules/marketing/contact.service";
import { findOrCreateByEmailDomain } from "@/modules/marketing/company.service";
import { BadRequestError } from "@/utils/error";
import { ContactConsentStatus, SuppressionReason, ConsentAction } from "@prisma/client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sentinel userId for system-initiated actions (public forms, webhooks). */
const SYSTEM_USER_ID = "system";

/**
 * Dedup window for pilot applications: a second submission of the same
 * normalised email within this window returns the same success shape without
 * re-running the contact-creation flow.
 */
const PILOT_APPLY_DEDUP_TTL = 600; // seconds
const BLOG_NEWSLETTER_DEDUP_TTL = 3600; // seconds

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function mapError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  if (error instanceof BadRequestError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  throw new TRPCError({
    code:    "INTERNAL_SERVER_ERROR",
    message: error instanceof Error ? error.message : "An unexpected error occurred.",
  });
}

async function enforceUnsubscribeRateLimit(ip: string | undefined, action: string): Promise<void> {
  const result = await rateLimiter.check(hashIp(ip), action, 10, 900, { failClosed: true });
  if (!result.allowed) {
    const suffix = result.retryAfter ? ` Try again in ${result.retryAfter} seconds.` : "";
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Too many unsubscribe requests.${suffix}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const publicMarketingRouter = router({
  /**
   * Validate an unsubscribe token without consuming it.
   * Returns { valid: true, email } or { valid: false }
   */
  validateUnsubscribeToken: publicProcedure
    .input(z.object({ token: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      try {
        await enforceUnsubscribeRateLimit(ctx.req.ip, "marketing-validate-unsubscribe-token");

        const tokenHash = hashToken(input.token);

        const send = await prisma.campaignSend.findFirst({
          where: {
            unsubscribeTokenHash: tokenHash,
            unsubscribedAt:       null,
          },
          include: { contact: { select: { email: true } } },
        });

        if (!send) {
          return { valid: false as const, email: null };
        }

        return { valid: true as const, email: send.contact.email };
      } catch (err) {
        mapError(err);
      }
    }),

  /**
   * Confirm unsubscribe - suppresses the contact and marks the token used.
   */
  unsubscribe: publicProcedure
    .input(z.object({ token: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      try {
        await enforceUnsubscribeRateLimit(ctx.req.ip, "marketing-unsubscribe");

        const tokenHash = hashToken(input.token);

        const send = await prisma.campaignSend.findFirst({
          where: {
            unsubscribeTokenHash: tokenHash,
            unsubscribedAt:       null,
          },
          include: {
            contact:  { select: { email: true, id: true } },
            campaign: { select: { id: true } },
          },
        });

        if (!send) {
          throw new BadRequestError("This unsubscribe link is invalid or has already been used.");
        }

        const email      = send.contact.email;
        const contactId  = send.contact.id;
        const campaignId = send.campaign.id;

        // 1. Suppress the email
        await suppress(email, SuppressionReason.UNSUBSCRIBED, undefined, {
          source: "unsubscribe_link",
          campaignId,
        });

        // 2. Record consent revocation
        await recordConsent({
          contactId,
          action:   ConsentAction.REVOKED,
          source:   "unsubscribe_link",
          metadata: { campaignId },
        });

        // 3. Mark token as used
        await prisma.campaignSend.update({
          where: { id: send.id },
          data:  { unsubscribedAt: new Date() },
        });

        // 4. Increment campaign unsubscribed counter
        await prisma.marketingCampaign.update({
          where: { id: campaignId },
          data:  { totalUnsubscribed: { increment: 1 } },
        });

        return { success: true };
      } catch (err) {
        mapError(err);
      }
    }),

  /**
   * Apply for the SheriaBot Pilot Programme.
   *
   * Security controls applied in middleware-chain order:
   *   1. rateLimited('pilotApply', 5, { window: 600 }) -- 5 submissions per
   *      IP per 10 min; identifier is ctx.req.ip (Fastify, respects
   *      trustProxy setting in app.ts).
   *   2. Email idempotency sentinel -- redis nx key on normalised email hash,
   *      600 s TTL. Duplicate submissions within the window return the same
   *      { success: true } shape without re-running the contact flow.
   *
   * Creates/updates a Contact with consent on first submission.
   */
  applyForPilot: publicProcedure
    .use(rateLimited('pilotApply', 5, {
      window:     600,
      identifier: (ctx) => ctx.req.ip ?? 'anonymous',
    }))
    .input(z.object({
      firstName:   z.string().min(1).max(100),
      lastName:    z.string().min(1).max(100),
      email:       z.string().email(),
      companyName: z.string().min(1).max(200),
      jobTitle:    z.string().min(1).max(100),
      phone:       z.string().optional(),
      message:     z.string().max(1000).optional(),
    }))
    .mutation(async ({ input }) => {
      try {
        const { firstName, lastName, email, companyName, jobTitle, phone } = input;
        const normalizedEmail = email.trim().toLowerCase();

        // Email idempotency: duplicate submissions within the 600 s window
        // return the same success shape without re-running the contact flow.
        // Key uses the full SHA-256 hex of the normalised email to avoid collisions.
        const emailHash = crypto.createHash('sha256').update(normalizedEmail).digest('hex');
        const dedupKey  = `sheriabot:pilot_apply:dedup:${emailHash}`;

        // Upstash redis.set with { nx: true } returns 'OK' when the key is
        // newly written, null when the key already exists.
        const acquired = await redis.set(dedupKey, '1', { nx: true, ex: PILOT_APPLY_DEDUP_TTL });
        if (acquired === null) {
          logger.info({
            type:        'pilot_apply_dedup_hit',
            emailPrefix: emailHash.slice(0, 8),
          });
          return { success: true };
        }

        // 1. Find or create company (uses email domain heuristic)
        const companyId = await findOrCreateByEmailDomain(
          normalizedEmail,
          companyName,
          SYSTEM_USER_ID,
        );

        // 2. Upsert contact (use normalised email consistently)
        const existing = await prisma.contact.findFirst({
          where: { email: normalizedEmail, deletedAt: null },
        });

        let contactId: string;

        if (existing) {
          const updated = await updateContact(
            existing.id,
            { firstName, lastName, role: jobTitle, phone: phone ?? undefined },
            SYSTEM_USER_ID,
          );
          contactId = updated.id;

          await prisma.contact.update({
            where: { id: contactId },
            data:  { consentStatus: "GRANTED", consentSource: "pilot_apply_form" },
          });
        } else {
          const created = await createContact(
            {
              email:     normalizedEmail,
              firstName,
              lastName,
              role:      jobTitle,
              phone:     phone ?? undefined,
              companyId: companyId ?? undefined,
            },
            SYSTEM_USER_ID,
          );
          contactId = created.id;

          await prisma.contact.update({
            where: { id: contactId },
            data:  { consentStatus: "GRANTED", consentSource: "pilot_apply_form" },
          });
        }

        // 3. Record consent log
        await recordConsent({
          contactId,
          action: ConsentAction.GRANTED,
          source: "pilot_apply_form",
        });

        logger.info({
          type:        'pilot_apply_submitted',
          contactId,
          emailPrefix: emailHash.slice(0, 8),
        });

        return { success: true };
      } catch (err) {
        mapError(err);
      }
    }),

  /**
   * Subscribe to the Blog newsletter using the existing marketing Contact and
   * ConsentRecord infrastructure. The response is intentionally generic for
   * duplicate, existing, and newly-created contacts.
   */
  subscribeBlogNewsletter: publicProcedure
    .use(rateLimited('blogNewsletterSubscribe', 5, {
      window: 900,
      identifier: (ctx) => hashIp(ctx.req.ip),
    }))
    .input(z.object({
      email: z.string().trim().email().max(254),
      sourcePage: z.string().trim().max(200).optional(),
      readerSessionId: z.string().trim().max(120).optional(),
      privacyPolicyVersion: z.string().trim().max(80).optional(),
      spamTrap: z.string().max(200).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        const normalizedEmail = input.email.trim().toLowerCase();
        const emailHash = crypto.createHash('sha256').update(normalizedEmail).digest('hex');
        const dedupKey = `sheriabot:blog_newsletter:dedup:${emailHash}`;

        const acquired = await redis.set(dedupKey, '1', { nx: true, ex: BLOG_NEWSLETTER_DEDUP_TTL });
        if (acquired === null) {
          logger.info({ type: 'blog_newsletter_subscription_dedup_hit', emailPrefix: emailHash.slice(0, 8) });
          return { success: true };
        }

        if (input.spamTrap?.trim()) {
          logger.info({ type: 'blog_newsletter_subscription_spam_trap', emailPrefix: emailHash.slice(0, 8) });
          return { success: true };
        }

        if (await isSuppressed(normalizedEmail)) {
          logger.info({ type: 'blog_newsletter_subscription_suppressed', emailPrefix: emailHash.slice(0, 8) });
          return { success: true };
        }

        const now = new Date();
        const metadata = {
          source: 'blog_newsletter',
          sourcePage: input.sourcePage ?? null,
          privacyPolicyVersion: input.privacyPolicyVersion ?? null,
          readerSessionHash: input.readerSessionId
            ? crypto.createHash('sha256').update(input.readerSessionId).digest('hex').slice(0, 32)
            : null,
          requestIpHash: hashIp(ctx.req.ip),
        };

        const listId = process.env.SHERIABOT_BLOG_NEWSLETTER_LIST_ID || process.env.SHERIABOT_NEWSLETTER_LIST_ID;

        const contact = await prisma.$transaction(async (tx) => {
          const existing = await tx.contact.findUnique({
            where: { email: normalizedEmail },
            select: { id: true, tags: true, deletedAt: true },
          });

          const tags = ['blog-newsletter'];
          const contactRecord = existing && !existing.deletedAt
            ? await tx.contact.update({
                where: { id: existing.id },
                data: {
                  consentStatus: ContactConsentStatus.GRANTED,
                  consentSource: 'blog_newsletter_form',
                  consentTimestamp: now,
                  tags: [...new Set([...existing.tags, ...tags])].slice(0, 10),
                },
                select: { id: true },
              })
            : await tx.contact.create({
                data: {
                  email: normalizedEmail,
                  consentStatus: ContactConsentStatus.GRANTED,
                  consentSource: 'blog_newsletter_form',
                  consentTimestamp: now,
                  tags,
                  createdById: SYSTEM_USER_ID,
                },
                select: { id: true },
              });

          await tx.consentRecord.create({
            data: {
              contactId: contactRecord.id,
              action: ConsentAction.GRANTED,
              source: 'blog_newsletter_form',
              metadata,
              occurredAt: now,
            },
          });

          if (listId) {
            const list = await tx.contactList.findFirst({
              where: { id: listId, deletedAt: null },
              select: { id: true },
            });

            if (list) {
              await tx.contactListMembership.upsert({
                where: { listId_contactId: { listId: list.id, contactId: contactRecord.id } },
                create: { listId: list.id, contactId: contactRecord.id, addedById: SYSTEM_USER_ID },
                update: {},
              });
            } else {
              logger.warn({ type: 'blog_newsletter_list_missing', listConfigured: true });
            }
          }

          return contactRecord;
        });

        logger.info({ type: 'blog_newsletter_subscription_completed', contactId: contact.id, emailPrefix: emailHash.slice(0, 8) });
        return { success: true };
      } catch (err) {
        mapError(err);
      }
    }),
});
