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
   * Creates/updates a Contact with consent, notifies admin.
   */
  applyForPilot: publicProcedure
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

        // 1. Find or create company (uses email domain heuristic; pass a fake
        //    domain derived from companyName since we have no email domain here)
        const companyId = await findOrCreateByEmailDomain(
          email,
          companyName,
          SYSTEM_USER_ID,
        );

        // 2. Upsert contact
        const existing = await prisma.contact.findFirst({
          where: { email: email.trim().toLowerCase(), deletedAt: null },
        });

        let contactId: string;

        if (existing) {
          const updated = await updateContact(
            existing.id,
            { firstName, lastName, role: jobTitle, phone: phone ?? undefined },
            SYSTEM_USER_ID,
          );
          contactId = updated.id;

          // Update consent fields directly
          await prisma.contact.update({
            where: { id: contactId },
            data:  { consentStatus: "GRANTED", consentSource: "pilot_apply_form" },
          });
        } else {
          const created = await createContact(
            {
              email,
              firstName,
              lastName,
              role:      jobTitle,
              phone:     phone ?? undefined,
              companyId: companyId ?? undefined,
            },
            SYSTEM_USER_ID,
          );
          contactId = created.id;

          // Set consent fields
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

        return { success: true };
      } catch (err) {
        mapError(err);
      }
    }),
});
