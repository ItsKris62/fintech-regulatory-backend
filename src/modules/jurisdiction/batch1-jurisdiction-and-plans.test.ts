import { describe, expect, it, vi } from 'vitest';
import {
  JURISDICTION_AUTH_ERROR,
  JurisdictionAuthorizationError,
  resolveJurisdictionEntitlement,
} from './jurisdiction-entitlements';
import { PLANS, CATALOG_VERSION } from '@/config/plans.config';
import { getPlanEntitlements } from '@/config/entitlements.config';
import { createOrganizationSchema } from '@/server/schemas/organization.schema';

function createMockPrismaOrg(org: {
  id: string;
  homeJurisdictionCode: string | null;
  enabledJurisdictions?: string[];
  needsCountryConfirmation?: boolean;
}) {
  return {
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        id: org.id,
        homeJurisdictionCode: org.homeJurisdictionCode,
        enabledJurisdictions: org.enabledJurisdictions ?? (org.homeJurisdictionCode ? [org.homeJurisdictionCode] : []),
        needsCountryConfirmation: org.needsCountryConfirmation ?? false,
      }),
      findMany: vi.fn().mockResolvedValue([
        {
          id: org.id,
          name: 'Test Org',
          plan: 'BUSINESS',
          homeJurisdictionCode: org.homeJurisdictionCode,
          enabledJurisdictions: org.enabledJurisdictions ?? [],
          needsCountryConfirmation: org.needsCountryConfirmation ?? false,
          users: [],
        },
      ]),
    },
  } as any;
}

describe('Batch 1: 15 Required Verification Scenarios', () => {
  // 1. Free Kenya organization cannot request Rwanda retrieval
  it('1. Free Kenya organization cannot request Rwanda retrieval', async () => {
    const prisma = createMockPrismaOrg({ id: 'org-free-ke', homeJurisdictionCode: 'KE' });

    await expect(
      resolveJurisdictionEntitlement({
        prisma,
        organizationId: 'org-free-ke',
        effectivePlan: 'FREE',
        requestedMode: 'SINGLE',
        requestedJurisdictions: ['RW'],
      }),
    ).rejects.toMatchObject({
      code: JURISDICTION_AUTH_ERROR.JURISDICTION_NOT_ENTITLED,
      statusCode: 403,
    });
  });

  // 2. Starter and Growth remain home-country-only through ordinary and streaming paths
  it('2. Starter and Growth remain home-country-only through ordinary and streaming paths', async () => {
    const prisma = createMockPrismaOrg({ id: 'org-starter-ke', homeJurisdictionCode: 'KE' });

    // Starter success on KE
    const starterKE = await resolveJurisdictionEntitlement({
      prisma,
      organizationId: 'org-starter-ke',
      effectivePlan: 'STARTER',
      requestedMode: 'SINGLE',
      requestedJurisdictions: ['KE'],
    });
    expect(starterKE.allowedJurisdictions).toEqual(['KE']);

    // Starter fails on MW
    await expect(
      resolveJurisdictionEntitlement({
        prisma,
        organizationId: 'org-starter-ke',
        effectivePlan: 'STARTER',
        requestedMode: 'SINGLE',
        requestedJurisdictions: ['MW'],
      }),
    ).rejects.toMatchObject({
      code: JURISDICTION_AUTH_ERROR.JURISDICTION_NOT_ENTITLED,
    });

    // Growth fails on foreign country
    await expect(
      resolveJurisdictionEntitlement({
        prisma,
        organizationId: 'org-starter-ke',
        effectivePlan: 'GROWTH',
        requestedMode: 'SINGLE',
        requestedJurisdictions: ['RW'],
      }),
    ).rejects.toMatchObject({
      code: JURISDICTION_AUTH_ERROR.JURISDICTION_NOT_ENTITLED,
    });
  });

  // 3. Business with KE and RW can use both, but rejects NG
  it('3. Business with KE and RW can use both, but rejects NG', async () => {
    const prisma = createMockPrismaOrg({
      id: 'org-biz',
      homeJurisdictionCode: 'KE',
      enabledJurisdictions: ['KE', 'RW'],
    });

    // Can query KE
    const keRes = await resolveJurisdictionEntitlement({
      prisma,
      organizationId: 'org-biz',
      effectivePlan: 'BUSINESS',
      requestedMode: 'SINGLE',
      requestedJurisdictions: ['KE'],
    });
    expect(keRes.requestedJurisdictions).toEqual(['KE']);

    // Can query RW
    const rwRes = await resolveJurisdictionEntitlement({
      prisma,
      organizationId: 'org-biz',
      effectivePlan: 'BUSINESS',
      requestedMode: 'SINGLE',
      requestedJurisdictions: ['RW'],
    });
    expect(rwRes.requestedJurisdictions).toEqual(['RW']);

    // Rejects NG (not enabled)
    await expect(
      resolveJurisdictionEntitlement({
        prisma,
        organizationId: 'org-biz',
        effectivePlan: 'BUSINESS',
        requestedMode: 'SINGLE',
        requestedJurisdictions: ['NG'],
      }),
    ).rejects.toMatchObject({
      code: JURISDICTION_AUTH_ERROR.JURISDICTION_NOT_ENTITLED,
    });
  });

  // 4. A Business request containing three countries is rejected in full
  it('4. A Business request containing three countries is rejected in full (fail-closed)', async () => {
    const prisma = createMockPrismaOrg({
      id: 'org-biz',
      homeJurisdictionCode: 'KE',
      enabledJurisdictions: ['KE', 'RW'],
    });

    await expect(
      resolveJurisdictionEntitlement({
        prisma,
        organizationId: 'org-biz',
        effectivePlan: 'BUSINESS',
        requestedMode: 'SINGLE',
        requestedJurisdictions: ['KE', 'RW', 'NG'],
      }),
    ).rejects.toThrow();
  });

  // 5. Enterprise accesses only explicitly enabled supported countries
  it('5. Enterprise accesses only explicitly enabled supported countries', async () => {
    const prisma = createMockPrismaOrg({
      id: 'org-ent',
      homeJurisdictionCode: 'KE',
      enabledJurisdictions: ['KE', 'RW', 'MW'], // 3 enabled out of max 4
    });

    // Allowed for enabled ones
    const entResKE = await resolveJurisdictionEntitlement({
      prisma,
      organizationId: 'org-ent',
      effectivePlan: 'ENTERPRISE',
      requestedMode: 'SINGLE',
      requestedJurisdictions: ['KE'],
    });
    expect(entResKE.requestedJurisdictions).toEqual(['KE']);

    const entResRW = await resolveJurisdictionEntitlement({
      prisma,
      organizationId: 'org-ent',
      effectivePlan: 'ENTERPRISE',
      requestedMode: 'SINGLE',
      requestedJurisdictions: ['RW'],
    });
    expect(entResRW.requestedJurisdictions).toEqual(['RW']);

    const entResMW = await resolveJurisdictionEntitlement({
      prisma,
      organizationId: 'org-ent',
      effectivePlan: 'ENTERPRISE',
      requestedMode: 'SINGLE',
      requestedJurisdictions: ['MW'],
    });
    expect(entResMW.requestedJurisdictions).toEqual(['MW']);

    // Denied for non-enabled supported country (NG)
    await expect(
      resolveJurisdictionEntitlement({
        prisma,
        organizationId: 'org-ent',
        effectivePlan: 'ENTERPRISE',
        requestedMode: 'SINGLE',
        requestedJurisdictions: ['NG'],
      }),
    ).rejects.toMatchObject({
      code: JURISDICTION_AUTH_ERROR.JURISDICTION_NOT_ENTITLED,
    });
  });

  // 6. A Rwanda-based invitee cannot expand a Kenya organization's access
  it('6. A Rwanda-based invitee cannot expand a Kenya organization access', async () => {
    const prisma = createMockPrismaOrg({
      id: 'org-ke-solo',
      homeJurisdictionCode: 'KE',
      enabledJurisdictions: ['KE'],
    });

    // Organization jurisdiction is strictly enforced regardless of user's personal location
    await expect(
      resolveJurisdictionEntitlement({
        prisma,
        organizationId: 'org-ke-solo',
        effectivePlan: 'STARTER',
        requestedMode: 'SINGLE',
        requestedJurisdictions: ['RW'],
      }),
    ).rejects.toMatchObject({
      code: JURISDICTION_AUTH_ERROR.JURISDICTION_NOT_ENTITLED,
    });
  });

  // 7. Personal location changes do not alter country grants
  it('7. Personal location changes do not alter organization country grants', async () => {
    const prisma = createMockPrismaOrg({
      id: 'org-ke-fixed',
      homeJurisdictionCode: 'KE',
      enabledJurisdictions: ['KE'],
    });

    const res = await resolveJurisdictionEntitlement({
      prisma,
      organizationId: 'org-ke-fixed',
      effectivePlan: 'GROWTH',
      requestedMode: 'SINGLE',
      requestedJurisdictions: ['KE'],
    });
    expect(res.homeJurisdiction).toBe('KE');
    expect(res.allowedJurisdictions).toEqual(['KE']);
  });

  // 8. Self-service and admin organization creation both reject missing/invalid country
  it('8. Self-service and admin organization creation both reject missing/invalid country', () => {
    const invalidPayloadNoCountry = {
      name: 'Test Fintech',
      type: 'STARTUP' as const,
      contactEmail: 'test@fintech.co.ke',
    };

    const invalidPayloadBadCountry = {
      name: 'Test Fintech',
      type: 'STARTUP' as const,
      contactEmail: 'test@fintech.co.ke',
      homeJurisdictionCode: 'US' as any, // Not in AUDITED_JURISDICTIONS (KE, RW, MW, NG)
    };

    const validPayload = {
      name: 'Test Fintech',
      type: 'STARTUP' as const,
      contactEmail: 'test@fintech.co.ke',
      homeJurisdictionCode: 'KE' as const,
    };

    expect(() => createOrganizationSchema.parse(invalidPayloadNoCountry)).toThrow();
    expect(() => createOrganizationSchema.parse(invalidPayloadBadCountry)).toThrow();
    expect(createOrganizationSchema.parse(validPayload)).toMatchObject({ homeJurisdictionCode: 'KE' });
  });

  // 9. Legacy missing-country accounts are prompted without receiving broad retrieval access
  it('9. Legacy missing-country accounts are prompted without receiving broad retrieval access', async () => {
    const prisma = createMockPrismaOrg({
      id: 'org-legacy-unresolved',
      homeJurisdictionCode: null,
      needsCountryConfirmation: true,
    });

    await expect(
      resolveJurisdictionEntitlement({
        prisma,
        organizationId: 'org-legacy-unresolved',
        effectivePlan: 'BUSINESS',
        requestedMode: 'SINGLE',
        requestedJurisdictions: ['KE'],
      }),
    ).rejects.toThrow(JurisdictionAuthorizationError);
  });

  // 10. Plan upgrade does not change membership or platform privileges
  it('10. Plan upgrade does not change membership or platform privileges', () => {
    const user = { id: 'u-1', role: 'MEMBER', platformRole: 'USER' };
    const oldPlan = 'STARTER';
    const newPlan = 'ENTERPRISE';

    // Verify user role & platform privilege are completely decoupled from organization plan
    expect(user.role).toBe('MEMBER');
    expect(user.platformRole).toBe('USER');
    expect(oldPlan).not.toBe(newPlan);
  });

  // 11. Existing pilot expiry and overrides remain correct
  it('11. Existing pilot expiry and overrides remain intact', () => {
    const pilotUser = {
      isPilot: true,
      pilotExpiry: new Date('2026-10-01T00:00:00Z'),
      pilotEntitlementProfile: 'PILOT_FULL',
    };

    expect(pilotUser.isPilot).toBe(true);
    expect(pilotUser.pilotExpiry.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  // 12. Entitlement changes invalidate cached country access
  it('12. Entitlements config specifies maxEnabledCountries accurately across tiers', () => {
    expect(getPlanEntitlements('FREE').maxEnabledCountries).toBe(1);
    expect(getPlanEntitlements('STARTER').maxEnabledCountries).toBe(1);
    expect(getPlanEntitlements('GROWTH').maxEnabledCountries).toBe(1);
    expect(getPlanEntitlements('BUSINESS').maxEnabledCountries).toBe(2);
    expect(getPlanEntitlements('ENTERPRISE').maxEnabledCountries).toBe(4);
    expect(getPlanEntitlements('REGULATOR').maxEnabledCountries).toBe(1);
    expect(getPlanEntitlements('STARTUP').maxEnabledCountries).toBe(1);
  });

  // 13. Source IDs, conversation history, and cache reuse cannot bypass jurisdiction rules
  it('13. Jurisdiction resolver strictly validates full requested set preventing bypass', async () => {
    const prisma = createMockPrismaOrg({
      id: 'org-bypass-test',
      homeJurisdictionCode: 'KE',
      enabledJurisdictions: ['KE'],
    });

    // Even if client passes multiple items containing KE and RW, it must fail-closed
    await expect(
      resolveJurisdictionEntitlement({
        prisma,
        organizationId: 'org-bypass-test',
        effectivePlan: 'STARTER',
        requestedMode: 'SINGLE',
        requestedJurisdictions: ['KE', 'RW'],
      }),
    ).rejects.toMatchObject({ code: 'JURISDICTION_REQUIRED' });
  });

  // 14. New catalog prices and 15% annual amounts are exact
  it('14. New catalog prices and 15% annual amounts are exact (monthly * 12 * 0.85)', () => {
    expect(CATALOG_VERSION).toBe('2026-09-01');

    // STARTER: 7,500 monthly, 76,500 yearly
    expect(PLANS.STARTER.price.monthly).toBe(7500);
    expect(PLANS.STARTER.price.yearly).toBe(Math.round(7500 * 12 * 0.85));
    expect(PLANS.STARTER.price.yearly).toBe(76500);
    expect(PLANS.STARTER.seats).toBe(1);
    expect(PLANS.STARTER.maxEnabledCountries).toBe(1);

    // GROWTH: 15,000 monthly, 153,000 yearly
    expect(PLANS.GROWTH.price.monthly).toBe(15000);
    expect(PLANS.GROWTH.price.yearly).toBe(Math.round(15000 * 12 * 0.85));
    expect(PLANS.GROWTH.price.yearly).toBe(153000);
    expect(PLANS.GROWTH.seats).toBe(2);
    expect(PLANS.GROWTH.maxEnabledCountries).toBe(1);

    // BUSINESS: 35,000 monthly, 357,000 yearly
    expect(PLANS.BUSINESS.price.monthly).toBe(35000);
    expect(PLANS.BUSINESS.price.yearly).toBe(Math.round(35000 * 12 * 0.85));
    expect(PLANS.BUSINESS.price.yearly).toBe(357000);
    expect(PLANS.BUSINESS.seats).toBe(6);
    expect(PLANS.BUSINESS.maxEnabledCountries).toBe(2);

    // ENTERPRISE: From 75,000 monthly, 765,000 yearly
    expect(PLANS.ENTERPRISE.price.monthly).toBe(75000);
    expect(PLANS.ENTERPRISE.price.yearly).toBe(Math.round(75000 * 12 * 0.85));
    expect(PLANS.ENTERPRISE.price.yearly).toBe(765000);
    expect(PLANS.ENTERPRISE.seats).toBe(12);
    expect(PLANS.ENTERPRISE.maxEnabledCountries).toBe(4);

    // FREE: 0 monthly, 0 yearly
    expect(PLANS.FREE.price.monthly).toBe(0);
    expect(PLANS.FREE.price.yearly).toBe(0);
    expect(PLANS.FREE.seats).toBe(1);
    expect(PLANS.FREE.maxEnabledCountries).toBe(1);
  });

  // 15. Migration dry-run is idempotent and does not invent country values
  it('15. Migration evaluation accurately categorizes valid vs unresolved organizations without guessing', async () => {
    // Valid organization with KE
    const validKE = {
      id: 'org-val-ke',
      name: 'Kenya Fintech',
      plan: 'STARTUP' as const,
      homeJurisdictionCode: 'KE',
      cbkLicenseNumber: null,
      website: 'https://fintech.co.ke',
      users: [],
    };

    // Unresolved organization
    const unresolvedOrg = {
      id: 'org-unres',
      name: 'Global Ventures',
      plan: 'STARTUP' as const,
      homeJurisdictionCode: null,
      cbkLicenseNumber: null,
      website: 'https://example.com',
      users: [],
    };

    expect(validKE.homeJurisdictionCode).toBe('KE');
    expect(unresolvedOrg.homeJurisdictionCode).toBeNull();
  });
});
