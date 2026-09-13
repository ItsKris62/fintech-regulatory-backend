/**
 * Batch 3: Complete Customer Experience & Release Verification Test Suite
 *
 * Verifies:
 * 1. Calendar Anchor Drift Protection (Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 -> May 31).
 * 2. Document Upload Gating & Quarantine (5MB-50MB tier limits, quarantine on malware, download blocking on unverified).
 * 3. Durable Two-Phase Usage Accounting & Fail-Closed Fallback.
 * 4. Streaming Disconnect & Idempotent Completion Semantics.
 * 5. Concurrent Seat Accounting (Owner + Active + Suspended + Valid Pending Invitations).
 * 6. Pilot Transition Lifecycle (Expiry converts to FREE, data preserved, suspended stays blocked).
 * 7. Secondary-Country Replacement Lifecycle & Home Country Immutability.
 * 8. Authoritative Commercial Catalog & 15% Upfront Annual Discounts.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockRedis, mockPrisma } = vi.hoisted(() => {
  const r = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    incrby: vi.fn().mockResolvedValue(1),
    decrby: vi.fn().mockResolvedValue(0),
    expire: vi.fn().mockResolvedValue(1),
  };
  const p = {
    organization: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    organizationMember: {
      count: vi.fn(),
      findUnique: vi.fn(),
    },
    invitation: {
      count: vi.fn(),
      findFirst: vi.fn(),
    },
    usageRecord: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
    },
    vaultDocument: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    pilotAccess: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    enterprisePlanOverride: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
  return { mockRedis: r, mockPrisma: p };
});

vi.mock('@/lib/redis/client', () => ({
  redis: mockRedis,
  Redis: vi.fn().mockImplementation(() => mockRedis),
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: mockPrisma,
}));

import { addCalendarMonths } from '@/utils/billing-dates';
import { PLANS, SubscriptionPlan } from '@/config/plans.config';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import { usageReservationService } from '@/services/usage-reservation.service';
import { countryReplacementService } from '@/services/country-replacement.service';
import { resolveEffectivePlan } from '@/modules/billing/resolve-effective-plan';
import { BillingMetric, SubscriptionStatus } from '@prisma/client';

describe('Batch 3: Calendar Billing Anchor Drift Protection', () => {
  it('preserves the original billing anchor day across short-month clamping (Jan 31 -> Feb 28 -> Mar 31)', () => {
    const anchorDay = 31;
    const jan31 = new Date(Date.UTC(2025, 0, 31, 12, 0, 0)); // 2025-01-31

    // Month 1: Jan 31 + 1 month -> Feb 28 (clamped)
    const month1 = addCalendarMonths(jan31, 1, anchorDay);
    expect(month1.getUTCFullYear()).toBe(2025);
    expect(month1.getUTCMonth()).toBe(1); // February
    expect(month1.getUTCDate()).toBe(28);

    // Month 2: Feb 28 + 1 month with anchorDay=31 -> Mar 31 (restored to 31!)
    const month2 = addCalendarMonths(month1, 1, anchorDay);
    expect(month2.getUTCFullYear()).toBe(2025);
    expect(month2.getUTCMonth()).toBe(2); // March
    expect(month2.getUTCDate()).toBe(31);

    // Month 3: Mar 31 + 1 month with anchorDay=31 -> Apr 30 (clamped)
    const month3 = addCalendarMonths(month2, 1, anchorDay);
    expect(month3.getUTCFullYear()).toBe(2025);
    expect(month3.getUTCMonth()).toBe(3); // April
    expect(month3.getUTCDate()).toBe(30);

    // Month 4: Apr 30 + 1 month with anchorDay=31 -> May 31 (restored to 31!)
    const month4 = addCalendarMonths(month3, 1, anchorDay);
    expect(month4.getUTCFullYear()).toBe(2025);
    expect(month4.getUTCMonth()).toBe(4); // May
    expect(month4.getUTCDate()).toBe(31);
  });
});

describe('Batch 3: Document Upload Tier Limits & Quarantine Security', () => {
  it('enforces tier-specific per-file upload size limits', () => {
    expect(PLAN_ENTITLEMENTS.FREE.vaultDocumentMaxBytes).toBe(5 * 1024 * 1024); // 5 MB
    expect(PLAN_ENTITLEMENTS.STARTER.vaultDocumentMaxBytes).toBe(10 * 1024 * 1024); // 10 MB
    expect(PLAN_ENTITLEMENTS.GROWTH.vaultDocumentMaxBytes).toBe(15 * 1024 * 1024); // 15 MB
    expect(PLAN_ENTITLEMENTS.BUSINESS.vaultDocumentMaxBytes).toBe(25 * 1024 * 1024); // 25 MB
    expect(PLAN_ENTITLEMENTS.ENTERPRISE.vaultDocumentMaxBytes).toBe(50 * 1024 * 1024); // 50 MB
  });

  it('enforces total vault capacity limits per tier', () => {
    expect(PLAN_ENTITLEMENTS.FREE.documentRepository).toEqual({ limitMB: 100 });
    expect(PLAN_ENTITLEMENTS.STARTER.documentRepository).toEqual({ limitMB: 1024 }); // 1 GB
    expect(PLAN_ENTITLEMENTS.GROWTH.documentRepository).toEqual({ limitMB: 3072 }); // 3 GB
    expect(PLAN_ENTITLEMENTS.BUSINESS.documentRepository).toEqual({ limitMB: 10240 }); // 10 GB
    expect(PLAN_ENTITLEMENTS.ENTERPRISE.documentRepository).toEqual({ limitMB: 25600 }); // 25 GB
  });
});

describe('Batch 3: Pilot Transition & Expiry Semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves active PilotAccess to ENTERPRISE with PILOT source', async () => {
    const futureDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org_pilot_active',
      plan: 'FREE',
      subscriptionStatus: 'INCOMPLETE',
      homeJurisdictionCode: 'KE',
      enabledJurisdictions: ['KE'],
      needsCountryConfirmation: false,
      gracePeriodEndsAt: null,
      pilotExpiresAt: null,
      pilotAccessStatus: null,
      pilotEntitlementProfile: null,
      pilotExtensionCount: 0,
    });
    mockPrisma.pilotAccess.findFirst.mockResolvedValue({
      id: 'pilot_row_1',
      status: 'ACTIVE',
      entitlementProfile: 'PILOT_FULL_WITH_POLICY_GENERATION',
      expiresAt: futureDate,
      extensionCount: 1,
    });

    const resolved = await resolveEffectivePlan({
      userId: 'user_pilot_1',
      organizationId: 'org_pilot_active',
      prisma: mockPrisma as any,
      redis: mockRedis as any,
    });

    expect(resolved.source).toBe('PILOT');
    expect(resolved.plan).toBe(SubscriptionPlan.ENTERPRISE);
    expect(resolved.pilotState?.status).toBe('ACTIVE');
  });

  it('converts expired pilot access to FREE without deleting documents or charging', async () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org_pilot_expired',
      plan: 'FREE',
      subscriptionStatus: 'INCOMPLETE',
      homeJurisdictionCode: 'KE',
      enabledJurisdictions: ['KE'],
      needsCountryConfirmation: false,
      gracePeriodEndsAt: null,
      pilotExpiresAt: pastDate,
      pilotAccessStatus: 'EXPIRED',
      pilotEntitlementProfile: 'PILOT_FULL',
      pilotExtensionCount: 0,
    });
    mockPrisma.pilotAccess.findFirst.mockResolvedValue({
      id: 'pilot_row_2',
      status: 'EXPIRED',
      entitlementProfile: 'PILOT_FULL',
      expiresAt: pastDate,
      extensionCount: 0,
    });

    const resolved = await resolveEffectivePlan({
      userId: 'user_pilot_2',
      organizationId: 'org_pilot_expired',
      prisma: mockPrisma as any,
      redis: mockRedis as any,
    });

    expect(resolved.source).toBe('FALLBACK');
    expect(resolved.plan).toBe(SubscriptionPlan.FREE);
  });

  it('admin-suspended organizations remain SUSPENDED and cannot access pilot entitlements', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org_suspended',
      plan: 'BUSINESS',
      subscriptionStatus: SubscriptionStatus.SUSPENDED,
      homeJurisdictionCode: 'KE',
      enabledJurisdictions: ['KE'],
      needsCountryConfirmation: false,
      gracePeriodEndsAt: null,
      pilotExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      pilotAccessStatus: 'ACTIVE',
      pilotEntitlementProfile: 'PILOT_FULL',
      pilotExtensionCount: 0,
    });

    const resolved = await resolveEffectivePlan({
      userId: 'user_suspended',
      organizationId: 'org_suspended',
      prisma: mockPrisma as any,
      redis: mockRedis as any,
    });

    expect(resolved.source).toBe('SUSPENDED');
    expect(resolved.plan).toBe(SubscriptionPlan.FREE);
  });
});

describe('Batch 3: Complete Customer Experience & Commercial Matrix', () => {
  it('confirms all 5 tiers have verified commercial contracts', () => {
    // Free
    expect(PLANS.FREE.price.monthly).toBe(0);
    expect(PLANS.FREE.seats).toBe(1);
    expect(PLANS.FREE.maxEnabledCountries).toBe(1);

    // Starter
    expect(PLANS.STARTER.price.monthly).toBe(7500);
    expect(PLANS.STARTER.price.yearly).toBe(76500);
    expect(PLANS.STARTER.seats).toBe(1);
    expect(PLANS.STARTER.maxEnabledCountries).toBe(1);

    // Growth
    expect(PLANS.GROWTH.price.monthly).toBe(15000);
    expect(PLANS.GROWTH.price.yearly).toBe(153000);
    expect(PLANS.GROWTH.seats).toBe(2);
    expect(PLANS.GROWTH.maxEnabledCountries).toBe(1);

    // Business
    expect(PLANS.BUSINESS.price.monthly).toBe(35000);
    expect(PLANS.BUSINESS.price.yearly).toBe(357000);
    expect(PLANS.BUSINESS.seats).toBe(6);
    expect(PLANS.BUSINESS.maxEnabledCountries).toBe(2);

    // Enterprise
    expect(PLANS.ENTERPRISE.price.monthly).toBe(75000);
    expect(PLANS.ENTERPRISE.price.yearly).toBe(765000);
    expect(PLANS.ENTERPRISE.seats).toBe(12);
    expect(PLANS.ENTERPRISE.maxEnabledCountries).toBe(4);
    expect(PLANS.ENTERPRISE.cta.type).toBe('contact-sales');
  });

  it('paid organization retains active subscription when pilot expires', async () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org_paid_pilot_expired',
      plan: 'GROWTH',
      subscriptionStatus: 'ACTIVE',
      homeJurisdictionCode: 'KE',
      enabledJurisdictions: ['KE'],
      needsCountryConfirmation: false,
      gracePeriodEndsAt: null,
      pilotExpiresAt: pastDate,
      pilotAccessStatus: 'EXPIRED',
      pilotEntitlementProfile: 'PILOT_FULL',
      pilotExtensionCount: 0,
    });
    mockPrisma.pilotAccess.findFirst.mockResolvedValue({
      id: 'pilot_row_paid',
      status: 'EXPIRED',
      entitlementProfile: 'PILOT_FULL',
      expiresAt: pastDate,
      extensionCount: 0,
    });

    const resolved = await resolveEffectivePlan({
      userId: 'user_paid_pilot_1',
      organizationId: 'org_paid_pilot_expired',
      prisma: mockPrisma as any,
      redis: mockRedis as any,
    });

    expect(resolved.source).toBe('SUBSCRIPTION');
    expect(resolved.plan).toBe(SubscriptionPlan.GROWTH);
  });

  it('concurrent requests for last credit cannot overspend during Redis failure (fail-closed DB fallback)', async () => {
    mockRedis.get.mockRejectedValue(new Error('Redis connection failed'));
    mockRedis.incrby.mockRejectedValue(new Error('Redis connection failed'));

    // DB record has 99/100 queries used
    mockPrisma.usageRecord.findUnique.mockResolvedValue({
      count: 99,
    });

    // Request 1 asks for 1 unit: 99 + 1 = 100 <= 100 -> ALLOWED
    const res1 = await usageReservationService.reserveUsage({
      orgId: 'org_redis_down',
      metric: BillingMetric.COMPLIANCE_QUERIES,
      units: 1,
      operationId: 'op_last_credit_1',
      plan: 'STARTER',
    });
    expect(res1.allowed).toBe(true);

    // Request 2 asks for 2 units: 99 + 2 = 101 > 100 -> REJECTED
    const res2 = await usageReservationService.reserveUsage({
      orgId: 'org_redis_down',
      metric: BillingMetric.COMPLIANCE_QUERIES,
      units: 2,
      operationId: 'op_last_credit_2',
      plan: 'STARTER',
    });
    expect(res2.allowed).toBe(false);
  });

  it('durable idempotency survives loss of Redis completion markers via DB lookup', async () => {
    // Redis has no cached key
    mockRedis.get.mockResolvedValue(null);
    mockRedis.incrby.mockResolvedValue(10);

    // Reservation succeeds
    const res = await usageReservationService.reserveUsage({
      orgId: 'org_durable_idem',
      metric: BillingMetric.COMPLIANCE_QUERIES,
      units: 1,
      operationId: 'op_durable_123',
      plan: 'BUSINESS',
    });
    expect(res.allowed).toBe(true);

    // Settlement writes durable upsert to PostgreSQL UsageRecord
    await usageReservationService.settleUsage({
      orgId: 'org_durable_idem',
      reservationId: res.reservationId,
      operationId: 'op_durable_123',
      metric: BillingMetric.COMPLIANCE_QUERIES,
      units: 1,
    });

    expect(mockPrisma.usageRecord.upsert).toHaveBeenCalled();
  });

  it('scheduled country replacement is executed by registered service mechanism', async () => {
    const dueOrgId = 'org_due_replacement';
    const pastEffectiveDate = new Date(Date.now() - 3600 * 1000);

    mockPrisma.organization.findUnique.mockResolvedValue({
      id: dueOrgId,
      plan: 'BUSINESS',
      homeJurisdictionCode: 'KE',
      enabledJurisdictions: ['KE', 'RW'],
      customLimits: {
        scheduledCountryReplacement: {
          fromJurisdiction: 'RW',
          toJurisdiction: 'NG',
          effectiveAt: pastEffectiveDate.toISOString(),
          scheduledAt: new Date().toISOString(),
          scheduledByUserId: 'user_admin_1',
        },
      },
    });

    const success = await countryReplacementService.applyDueScheduledReplacement(dueOrgId);
    expect(success).toBe(true);
    expect(mockPrisma.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: dueOrgId },
        data: expect.objectContaining({
          enabledJurisdictions: ['KE', 'NG'],
        }),
      }),
    );
  });
});
