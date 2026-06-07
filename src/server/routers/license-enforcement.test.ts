import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SubscriptionPlan } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PLAN_ENTITLEMENTS, PILOT_ENTITLEMENT_PROFILES } from '@/config/entitlements.config';
import { hasFeature } from '@/utils/entitlements';
import {
  addTimelineEventSchema,
  adminOverrideUpdateLicenseSchema,
  createLicenseSchema,
} from '../schemas/license.schema';

function repo(relativePath: string): string {
  return readFileSync(resolve(__dirname, '../../../..', relativePath), 'utf8');
}

function local(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('license management entitlement, RBAC, and governance map', () => {
  const licenseRouter = local('license.router.ts');
  const licenseService = repo('fintech-regulatory-backend/src/modules/license/license.service.ts');
  const schema = repo('fintech-regulatory-backend/prisma/schema.prisma');
  const migration = repo('fintech-regulatory-backend/prisma/migrations/20260607_license_management/migration.sql');

  it('keeps organization license procedures behind org membership and licenseManagement gating', () => {
    const procedures = [
      'list',
      'get',
      'create',
      'update',
      'archive',
      'addTimelineEvent',
      'updateTimelineEvent',
      'completeTimelineEvent',
      'addDocument',
      'removeDocument',
      'addFee',
      'updateFee',
      'getUpcomingRenewals',
      'getDashboardSummary',
    ];

    for (const procedure of procedures) {
      expect(licenseRouter).toContain(`${procedure}:`);
    }

    expect(licenseRouter).toContain('const licenseOrgProcedure = orgMemberProcedure');
    expect(licenseRouter).toContain('use(withPlanContext)');
    expect(licenseRouter).toContain("use(requirePlanFeature('licenseManagement'))");
  });

  it('requires owner/admin role for sensitive license mutations', () => {
    expect(licenseRouter).toContain('const licenseManagerProcedure = licenseOrgProcedure');
    expect(licenseRouter).toContain('requireOrgMembershipRole([MemberRole.ADMIN, MemberRole.OWNER])');
    expect(licenseService).toContain('Only organization owners and admins can manage licenses.');
  });

  it('preserves tier behavior for license management', () => {
    expect(PLAN_ENTITLEMENTS.STARTUP.licenseManagement).toBe(false);
    expect(hasFeature(SubscriptionPlan.STARTUP, 'licenseManagement')).toBe(false);
    expect(hasFeature(SubscriptionPlan.BUSINESS, 'licenseManagement')).toBe(true);
    expect(hasFeature(SubscriptionPlan.ENTERPRISE, 'licenseManagement')).toBe(true);
    expect(PILOT_ENTITLEMENT_PROFILES.PILOT_FULL.licenseManagement).toBe(true);
  });

  it('adds calendar source metadata and uses it for duplicate-safe generated events', () => {
    expect(schema).toContain('sourceType');
    expect(schema).toContain('sourceId');
    expect(schema).toContain('@@unique([organizationId, sourceType, sourceId])');
    expect(migration).toContain('ADD COLUMN "sourceType" TEXT');
    expect(licenseService).toContain('organizationId_sourceType_sourceId');
    expect(licenseService).toContain('LICENSE_RENEWAL');
    expect(licenseService).toContain('LICENSE_EXPIRY');
    expect(licenseService).toContain('LICENSE_TIMELINE');
  });

  it('keeps platform admin mutation in an explicit override procedure with reason and audit', () => {
    expect(licenseRouter).toContain('adminOverrideUpdate: adminProcedure');
    expect(adminOverrideUpdateLicenseSchema.safeParse({
      id: 'cm00000000000000000000000',
      reason: 'Correcting customer data after written support request.',
      status: 'ACTIVE',
    }).success).toBe(true);
    expect(adminOverrideUpdateLicenseSchema.safeParse({
      id: 'cm00000000000000000000000',
      reason: 'too short',
      status: 'ACTIVE',
    }).success).toBe(false);
    expect(licenseService).toContain('license.admin_override_updated');
    expect(licenseService).toContain('reason: params.adminOverrideReason');
  });

  it('validates core create and timeline inputs', () => {
    expect(createLicenseSchema.safeParse({
      licenseType: 'Payment Service Provider',
      regulator: 'Central Bank of Kenya',
      renewalDueDate: '2026-07-15T00:00:00.000Z',
    }).success).toBe(true);

    expect(addTimelineEventSchema.safeParse({
      licenseId: 'cm00000000000000000000000',
      eventType: 'REGULATOR_SUBMISSION',
      title: 'Submit renewal package',
      dueDate: '2026-07-01T00:00:00.000Z',
      createCalendarEvent: true,
    }).success).toBe(true);
  });

  it('guards evidence document links by organization', () => {
    expect(licenseService).toContain('assertVaultDocument');
    expect(licenseService).toContain('organizationId, deletedAt: null');
    expect(licenseService).toContain('Evidence document must belong to this organization.');
  });
});
