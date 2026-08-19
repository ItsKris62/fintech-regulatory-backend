/**
 * Verification Service
 *
 * Handles:
 * - Free email domain blocking (Zod utility)
 * - Regulator domain whitelist checking
 * - Invitation token lookup
 * - Tiered access level resolution
 * - Notification preference auto-creation
 */

import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import {
  findValidInvitationByEmailAndToken,
  hasPendingInvitationForEmail,
} from '@/server/services/organization-invitation.service';

// --- Free Email Blocklist -----------------------------------------------------

/**
 * Domains that are blocked for organizational accounts.
 * Maintained as a static list  -  changes rarely and requires a deployment.
 */
export const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'aol.com',
  'icloud.com',
  'mail.com',
  'protonmail.com',
  'zoho.com',
  'yandex.com',
  'gmx.com',
  'live.com',
  'msn.com',
  'yahoo.co.ke',
  'yahoo.co.uk',
  'googlemail.com',
]);

export function isFreeEmailDomain(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return FREE_EMAIL_DOMAINS.has(domain);
}

export const FREE_EMAIL_ERROR_MESSAGE =
  'Please use your business email address. Free email providers are not accepted for organizational accounts.';

// --- Regulator Domain Whitelist -----------------------------------------------

/**
 * Check if an email belongs to a known regulator domain.
 * Looks up the EmailDomainWhitelist table in the database.
 */
export async function isRegulatorDomain(email: string): Promise<{
  isRegulator: boolean;
  orgName?: string;
  domain?: string;
}> {
  try {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return { isRegulator: false };

    const entry = await prisma.emailDomainWhitelist.findFirst({
      where: { domain, isActive: true, orgType: 'regulator' },
    });

    if (entry) {
      return { isRegulator: true, orgName: entry.orgName, domain: entry.domain };
    }
    return { isRegulator: false };
  } catch (error: any) {
    logger.error({
      type: 'regulator_domain_check_error',
      email,
      error: error.message,
    });
    return { isRegulator: false };
  }
}

// --- Invitation Lookup --------------------------------------------------------

export interface ValidatedInvitation {
  id: string;
  email: string;
  role: string;
  organizationRole?: string | null;
  organizationId?: string | null;
  invitedBy: string;
}

/**
 * Find and validate an invitation token.
 * Returns null if the token is missing, expired, or already used.
 */
export async function findValidInvitation(
  email: string,
  token?: string,
): Promise<ValidatedInvitation | null> {
  try {
    const invitation = await findValidInvitationByEmailAndToken(prisma as any, email, token);

    if (!invitation) return null;

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      organizationRole: invitation.organizationRole,
      organizationId: invitation.organizationId,
      invitedBy: invitation.invitedBy,
    };
  } catch (error: any) {
    logger.error({
      type: 'invitation_lookup_error',
      email,
      error: error.message,
    });
    return null;
  }
}

export async function hasPendingInvitation(email: string): Promise<boolean> {
  try {
    return await hasPendingInvitationForEmail(prisma as any, email);
  } catch (error: any) {
    logger.error({
      type: 'invitation_pending_lookup_error',
      email,
      error: error.message,
    });
    return false;
  }
}

/**
 * Mark an invitation as used.
 */
export async function consumeInvitation(invitationId: string): Promise<void> {
  await prisma.invitation.update({
    where: { id: invitationId },
    data: { used: true, usedAt: new Date() },
  });
}

// --- Tiered Access ------------------------------------------------------------

export type AccessLevel = 'none' | 'basic' | 'full';

/**
 * Resolve the user's access level based on email verification and org status.
 *
 * - none  : email not verified OR account not active
 * - basic : email verified + account active (no org verification required)
 * - full  : email verified + active + organization verified
 */
export async function resolveAccessLevel(userId: string): Promise<AccessLevel> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        emailVerified: true,
        accountStatus: true,
        organizationId: true,
        organization: {
          select: { verificationStatus: true },
        },
      },
    });

    if (!user || !user.emailVerified || user.accountStatus !== 'active') {
      return 'none';
    }

    if (user.organization?.verificationStatus === 'verified') {
      return 'full';
    }

    return 'basic';
  } catch (error: any) {
    logger.error({
      type: 'resolve_access_level_error',
      userId,
      error: error.message,
    });
    return 'none';
  }
}

// --- Notification Preference Initialization -----------------------------------

/**
 * Create a NotificationPreference record for a new user (all defaults to true).
 * Safe to call multiple times  -  uses upsert to avoid duplicates.
 */
export async function initializeNotificationPreferences(userId: string): Promise<void> {
  try {
    await prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  } catch (error: any) {
    // Non-fatal  -  preferences will fall back to defaults
    logger.warn({
      type: 'init_notification_preferences_failed',
      userId,
      error: error.message,
    });
  }
}
