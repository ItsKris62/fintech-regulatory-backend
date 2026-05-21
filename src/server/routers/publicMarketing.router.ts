/**
 * Public Marketing Router — Phase B4
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
import { logger } from "@/utils/logger";
import { rateLimited } from "../trpc/middleware";
import { suppress } from "@/modules/marketing/suppression.service";
import { recordConsent } from "@/modules/marketing/consent.service";
import { createContact, updateContact } from "@/modules/marketing/contact.service";
import { findOrCreateByEmailDomain } from "@/modules/marketing/company.service";
import { BadRequestError } from "@/utils/error";
import { SuppressionReason, ConsentAction } from "@prisma/client";

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
    .query(async ({ input }) => {
      try {
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
   * Confirm unsubscribe — suppresses the contact and marks the token used.
   */
  unsubscribe: publicProcedure
    .input(z.object({ token: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
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
});
