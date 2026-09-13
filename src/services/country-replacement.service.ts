/**
 * Secondary-Country Replacement Lifecycle Service
 *
 * Rules:
 * - Free / Starter / Growth: Home country only (maxEnabledCountries: 1)
 * - Business: Home plus 1 enabled country (maxEnabledCountries: 2)
 * - Enterprise: Up to 4 explicitly enabled countries (maxEnabledCountries: 4)
 *
 * Initial selection into an unused entitled country slot is immediate.
 * Replacement of an existing secondary country is scheduled for the next monthly
 * entitlement renewal boundary for both monthly and annual subscribers.
 * The home country can never be replaced via this mechanism.
 */

import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { userCache } from '@/lib/redis/cache.service';
import { logger } from '@/utils/logger';
import { getPlanEntitlements } from '@/config/entitlements.config';
import { getMonthlyQuotaPeriod } from '@/utils/billing-dates';
import { AUDITED_JURISDICTIONS } from '@/config/jurisdictions.config';
import { TRPCError } from '@trpc/server';

export interface ScheduledCountryReplacement {
  fromJurisdiction: string;
  toJurisdiction: string;
  effectiveAt: string;
  scheduledAt: string;
  scheduledByUserId: string;
}

export interface ScheduleCountryReplacementInput {
  organizationId: string;
  userId: string;
  fromJurisdiction: string;
  toJurisdiction: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

class CountryReplacementService {
  /**
   * Schedules replacement of an existing secondary country for the next monthly entitlement boundary.
   */
  async scheduleReplacement(input: ScheduleCountryReplacementInput): Promise<{
    scheduled: boolean;
    effectiveAt: string;
    fromJurisdiction: string;
    toJurisdiction: string;
  }> {
    const { organizationId, userId, fromJurisdiction, toJurisdiction, ipAddress, userAgent } = input;

    const fromCode = fromJurisdiction.toUpperCase().trim();
    const toCode = toJurisdiction.toUpperCase().trim();

    if (fromCode === toCode) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Source and target jurisdictions must be different.',
      });
    }

    if (!AUDITED_JURISDICTIONS.includes(toCode as any)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Jurisdiction '${toCode}' is not currently supported.`,
      });
    }

    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        plan: true,
        homeJurisdictionCode: true,
        enabledJurisdictions: true,
        customLimits: true,
      },
    });

    if (!org) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
    }

    const home = org.homeJurisdictionCode?.toUpperCase().trim();
    if (fromCode === home) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Home jurisdiction cannot be replaced via secondary-country replacement. Update organization home country instead.',
      });
    }

    if (!org.enabledJurisdictions.map((j) => j.toUpperCase()).includes(fromCode)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Jurisdiction '${fromCode}' is not currently enabled for this organization.`,
      });
    }

    if (org.enabledJurisdictions.map((j) => j.toUpperCase()).includes(toCode)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Jurisdiction '${toCode}' is already enabled for this organization.`,
      });
    }

    const entitlements = getPlanEntitlements(org.plan as any);
    const maxCountries = entitlements.maxEnabledCountries ?? 1;

    if (maxCountries <= 1) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `Secondary jurisdiction replacement requires Business or Enterprise plan (current plan: ${org.plan}).`,
      });
    }

    // Schedule for the next monthly entitlement renewal boundary
    const { periodEnd } = getMonthlyQuotaPeriod();
    const effectiveAt = periodEnd.toISOString();

    const scheduledData: ScheduledCountryReplacement = {
      fromJurisdiction: fromCode,
      toJurisdiction: toCode,
      effectiveAt,
      scheduledAt: new Date().toISOString(),
      scheduledByUserId: userId,
    };

    const existingCustomLimits =
      typeof org.customLimits === 'object' && org.customLimits !== null && !Array.isArray(org.customLimits)
        ? (org.customLimits as Record<string, unknown>)
        : {};

    const updatedCustomLimits = {
      ...existingCustomLimits,
      scheduledCountryReplacement: scheduledData,
    };

    await prisma.organization.update({
      where: { id: organizationId },
      data: {
        customLimits: updatedCustomLimits,
        updatedAt: new Date(),
      },
    });

    await prisma.auditLog.create({
      data: {
        userId,
        action: 'country_replacement_scheduled',
        entityType: 'Organization',
        entityId: organizationId,
        metadata: {
          fromJurisdiction: fromCode,
          toJurisdiction: toCode,
          effectiveAt,
        },
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ?? null,
      },
    }).catch(() => {});

    logger.info({
      type: 'country_replacement_scheduled',
      organizationId,
      userId,
      fromJurisdiction: fromCode,
      toJurisdiction: toCode,
      effectiveAt,
    });

    return {
      scheduled: true,
      effectiveAt,
      fromJurisdiction: fromCode,
      toJurisdiction: toCode,
    };
  }

  /**
   * Retrieves pending scheduled country replacement if one exists.
   */
  async getScheduledReplacement(organizationId: string): Promise<ScheduledCountryReplacement | null> {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { customLimits: true },
    });

    if (!org || typeof org.customLimits !== 'object' || org.customLimits === null || Array.isArray(org.customLimits)) {
      return null;
    }

    const limits = org.customLimits as Record<string, unknown>;
    const scheduled = limits.scheduledCountryReplacement as ScheduledCountryReplacement | undefined;

    return scheduled ?? null;
  }

  /**
   * Cancels a pending scheduled country replacement.
   */
  async cancelScheduledReplacement(organizationId: string, userId: string): Promise<boolean> {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { customLimits: true },
    });

    if (!org) return false;

    const existingCustomLimits =
      typeof org.customLimits === 'object' && org.customLimits !== null && !Array.isArray(org.customLimits)
        ? (org.customLimits as Record<string, unknown>)
        : {};

    if (!existingCustomLimits.scheduledCountryReplacement) {
      return false;
    }

    const { scheduledCountryReplacement: _, ...restLimits } = existingCustomLimits;

    await prisma.organization.update({
      where: { id: organizationId },
      data: {
        customLimits: restLimits,
        updatedAt: new Date(),
      },
    });

    await prisma.auditLog.create({
      data: {
        userId,
        action: 'country_replacement_cancelled',
        entityType: 'Organization',
        entityId: organizationId,
        metadata: { cancelledByUserId: userId },
      },
    }).catch(() => {});

    logger.info({
      type: 'country_replacement_cancelled',
      organizationId,
      userId,
    });

    return true;
  }

  /**
   * Atomically executes any due scheduled country replacement.
   * Can be called by a periodic worker or on-demand at entitlement evaluation.
   */
  async applyDueScheduledReplacement(organizationId: string): Promise<boolean> {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        plan: true,
        homeJurisdictionCode: true,
        enabledJurisdictions: true,
        customLimits: true,
      },
    });

    if (!org) return false;

    const existingCustomLimits =
      typeof org.customLimits === 'object' && org.customLimits !== null && !Array.isArray(org.customLimits)
        ? (org.customLimits as Record<string, unknown>)
        : {};

    const scheduled = existingCustomLimits.scheduledCountryReplacement as ScheduledCountryReplacement | undefined;
    if (!scheduled) return false;

    const now = new Date();
    const effectiveDate = new Date(scheduled.effectiveAt);

    if (effectiveDate > now) {
      // Not yet due
      return false;
    }

    // Recheck entitlements
    const entitlements = getPlanEntitlements(org.plan as any);
    const maxCountries = entitlements.maxEnabledCountries ?? 1;

    // Apply the replacement
    let newEnabled = org.enabledJurisdictions.map((j) => (j.toUpperCase() === scheduled.fromJurisdiction ? scheduled.toJurisdiction : j));
    if (!newEnabled.includes(scheduled.toJurisdiction)) {
      newEnabled.push(scheduled.toJurisdiction);
    }
    // Remove duplicates
    newEnabled = Array.from(new Set(newEnabled));

    // Ensure capacity cap is respected
    if (newEnabled.length > maxCountries) {
      newEnabled = newEnabled.slice(0, maxCountries);
    }

    const { scheduledCountryReplacement: _, ...restLimits } = existingCustomLimits;

    await prisma.organization.update({
      where: { id: organizationId },
      data: {
        enabledJurisdictions: newEnabled,
        customLimits: restLimits,
        updatedAt: new Date(),
      },
    });

    // Invalidate caches
    await redis.del(`sheriabot:jurisdiction:${organizationId}`).catch(() => {});
    await userCache.delete(scheduled.scheduledByUserId).catch(() => {});

    logger.info({
      type: 'country_replacement_applied',
      organizationId,
      fromJurisdiction: scheduled.fromJurisdiction,
      toJurisdiction: scheduled.toJurisdiction,
      effectiveAt: scheduled.effectiveAt,
    });

    return true;
  }
}

export const countryReplacementService = new CountryReplacementService();
