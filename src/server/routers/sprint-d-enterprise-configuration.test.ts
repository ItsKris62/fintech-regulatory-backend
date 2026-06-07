import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function repo(relativePath: string): string {
  return readFileSync(resolve(__dirname, '../../../..', relativePath), 'utf8');
}

function local(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('Sprint D enterprise configuration foundation', () => {
  const schema = repo('fintech-regulatory-backend/prisma/schema.prisma');
  const migration = repo('fintech-regulatory-backend/prisma/migrations/20260607_custom_frameworks_enterprise_contracts/migration.sql');
  const customRouter = local('custom-framework.router.ts');
  const contractRouter = local('enterprise-contract.router.ts');
  const appRouter = repo('fintech-regulatory-backend/src/server/trpc/router.ts');
  const resolver = repo('fintech-regulatory-backend/src/modules/billing/resolve-effective-plan.ts');
  const middleware = repo('fintech-regulatory-backend/src/server/trpc/middleware.ts');
  const frameworkRouter = local('framework.router.ts');

  it('adds additive org-scoped custom framework and enterprise contract models', () => {
    expect(schema).toContain('model CustomFramework');
    expect(schema).toContain('model CustomFrameworkSection');
    expect(schema).toContain('model CustomFrameworkControl');
    expect(schema).toContain('model CustomFrameworkVersion');
    expect(schema).toContain('model EnterpriseContract');
    expect(schema).toContain('model EnterprisePlanOverride');
    expect(schema).toContain('@@unique([organizationId, slug])');
    expect(schema).toContain('@@unique([frameworkId, version])');
    expect(migration).toContain('CREATE TABLE "CustomFramework"');
    expect(migration).toContain('CREATE TABLE "EnterprisePlanOverride"');
  });

  it('keeps custom framework routes org-scoped, role-gated, and entitlement-gated', () => {
    expect(customRouter).toContain('orgMemberProcedure');
    expect(customRouter).toContain('orgMemberProcedureWithRole(managerRoles)');
    expect(customRouter).toContain("requirePlanFeature('customFrameworks')");
    expect(customRouter).toContain('ctx.orgMembership!.organizationId');
    expect(customRouter).toContain('assertDraft(framework)');
    expect(customRouter).toContain('customFrameworkVersion.create');
    expect(customRouter).toContain('status: \'PUBLISHED\'');
    expect(customRouter).toContain('status: \'ARCHIVED\'');
  });

  it('keeps contract override management platform-admin-only with reason and cache invalidation', () => {
    expect(contractRouter).toContain('adminProcedure');
    expect(contractRouter).toContain('const reasonSchema = z.string().trim().min(10)');
    expect(contractRouter).toContain('parseEnterpriseOverrideValue(input.key, input.value)');
    expect(contractRouter).toContain('enterprise_contract.override_added');
    expect(contractRouter).toContain('enterprise_contract.override_disabled');
    expect(contractRouter).toContain('planCtxCacheKey(user.id)');
    expect(contractRouter).toContain('adminPreviewEffectiveEntitlements');
  });

  it('routes effective entitlement resolution through central merged entitlements', () => {
    expect(resolver).toContain('loadActiveEnterpriseOverrides');
    expect(resolver).toContain('applyEnterpriseContractOverrides(baseEntitlements, activeOverrides)');
    expect(resolver).toContain('appliedOverrides');
    expect(middleware).toContain('const entitlements = resolved.entitlements');
    expect(middleware).toContain('entitlements,');
    expect(middleware).toContain('appliedPlanOverrides: resolved.appliedOverrides');
  });

  it('mounts routers and exposes custom frameworks through existing framework selector safely', () => {
    expect(appRouter).toContain('customFramework: customFrameworkRouter');
    expect(appRouter).toContain('enterpriseContract: enterpriseContractRouter');
    expect(frameworkRouter).toContain('canUseCustomFrameworks');
    expect(frameworkRouter).toContain('ctx.entitlements?.customFrameworks === true');
    expect(frameworkRouter).toContain('organizationId');
    expect(frameworkRouter).toContain('isCustom: true');
  });
});
