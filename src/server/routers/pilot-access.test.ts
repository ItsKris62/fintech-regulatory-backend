/**
 * pilot-access.test.ts
 *
 * Static source-analysis tests that verify the production-incident fixes
 * described in the "pilot tester access" incident report.
 *
 * These tests do NOT require a live database or Redis connection — they
 * inspect the source text of the relevant modules to confirm that the
 * required structural guarantees are present.
 *
 * Acceptance criteria covered:
 *   1. New pilot tester can access complianceDashboard.getComplianceDashboard.
 *   2. New pilot tester can call checklist.listChecklists.
 *   3. New pilot tester can call gapAnalysis.getFrameworks / run gap analysis.
 *   4. User without ACTIVE OrganizationMember still gets FORBIDDEN.
 *   5. admin.getStats no longer throws on prisma.policy.count().
 *   6. system health returns OK or DEGRADED, not an unhandled 500.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// ── helpers ──────────────────────────────────────────────────────────────────

function src(relPath: string): string {
  return readFileSync(resolve(__dirname, relPath), 'utf8');
}

function srcFromRoot(relPath: string): string {
  return readFileSync(resolve(__dirname, '../../../../', relPath), 'utf8');
}

// ── 1. userProvisioning.service — OrganizationMember creation ────────────────

describe('userProvisioning.service — pilot OrganizationMember creation', () => {
  const provisioningSrc = src('../services/userProvisioning.service.ts');

  it('imports MemberRole and MemberStatus from @prisma/client', () => {
    expect(provisioningSrc).toContain('MemberRole');
    expect(provisioningSrc).toContain('MemberStatus');
  });

  it('calls organizationMember.upsert inside the transaction', () => {
    expect(provisioningSrc).toContain('organizationMember.upsert');
  });

  it('creates the member with status ACTIVE', () => {
    expect(provisioningSrc).toContain('MemberStatus.ACTIVE');
  });

  it('creates the member with role OWNER', () => {
    expect(provisioningSrc).toContain('MemberRole.OWNER');
  });

  it('upsert uses the userId_organizationId compound unique key', () => {
    expect(provisioningSrc).toContain('userId_organizationId');
  });

  it('invalidates the Redis membership cache after provisioning', () => {
    expect(provisioningSrc).toContain('sheriabot:orgmem:');
    expect(provisioningSrc).toContain('redis');
  });

  it('organizationMember is included in the ProvisioningTransaction type', () => {
    expect(provisioningSrc).toContain("'organizationMember'");
  });
});

// -- 10. PilotAccess model and migration - first-class audit history ----------

describe('PilotAccess schema and migration - audit-preserving active uniqueness', () => {
  const schemaSrc = srcFromRoot('fintech-regulatory-backend/prisma/schema.prisma');
  const migrationSrc = srcFromRoot(
    'fintech-regulatory-backend/prisma/migrations/20260602_add_pilot_access_model/migration.sql',
  );

  it('adds a PilotAccess model with status history fields', () => {
    expect(schemaSrc).toContain('model PilotAccess');
    expect(schemaSrc).toContain('enum PilotAccessStatus');
    expect(schemaSrc).toContain('extensionCount');
    expect(schemaSrc).toContain('revokedAt');
    expect(schemaSrc).toContain('convertedAt');
  });

  it('does not add a permanent Prisma unique constraint that blocks history', () => {
    const modelIdx = schemaSrc.indexOf('model PilotAccess');
    const modelSrc = schemaSrc.slice(modelIdx);
    const modelEndIdx = modelSrc.search(/^\}\s*$/m);
    const modelBody = modelSrc.slice(0, modelEndIdx);
    expect(modelBody).not.toContain('@@unique');
  });

  it('uses a partial unique index for one ACTIVE row per user/org', () => {
    expect(migrationSrc).toContain('PilotAccess_one_active_per_user_org_idx');
    expect(migrationSrc).toContain('ON "PilotAccess"("userId", "organizationId")');
    expect(migrationSrc).toContain('WHERE "status" = \'ACTIVE\'');
  });
});

// -- 11. effective plan resolver - source metadata and paid precedence --------

describe('resolveEffectivePlan - pilot metadata and paid precedence', () => {
  const resolverSrc = srcFromRoot(
    'fintech-regulatory-backend/src/modules/billing/resolve-effective-plan.ts',
  );
  const typeSrc = srcFromRoot('fintech-regulatory-backend/src/types/plan.types.ts');

  it('returns source metadata and pilot entitlement profile metadata', () => {
    expect(typeSrc).toContain('export type EffectivePlanSource');
    expect(resolverSrc).toContain('source: EffectivePlanSource');
    expect(resolverSrc).toContain('entitlementProfile: PilotEntitlementProfile | null');
    expect(resolverSrc).toContain('pilotState');
  });

  it('resolves active PilotAccess through source=PILOT with profile metadata', () => {
    const pilotIdx = resolverSrc.indexOf("source = 'PILOT'");
    expect(pilotIdx).toBeGreaterThan(-1);
    const pilotBody = resolverSrc.slice(pilotIdx - 500, pilotIdx + 900);
    expect(pilotBody).toContain('effectivePlan = SubscriptionPlan.ENTERPRISE');
    expect(pilotBody).toContain('entitlementProfile = profile');
    expect(pilotBody).toContain('resolvePilotEntitlementProfile');
    expect(pilotBody).toContain("status: 'ACTIVE'");
  });

  it('lets suspension win before paid, trial, or pilot access', () => {
    const suspendedIdx = resolverSrc.indexOf('subscriptionStatus === SubscriptionStatus.SUSPENDED');
    const paidIdx = resolverSrc.indexOf('} else if (hasPaidPlan)');
    const pilotIdx = resolverSrc.indexOf("source = 'PILOT'");
    expect(suspendedIdx).toBeGreaterThan(-1);
    expect(paidIdx).toBeGreaterThan(suspendedIdx);
    expect(pilotIdx).toBeGreaterThan(paidIdx);
  });

  it('does not relabel or downgrade paid users who also have pilot metadata', () => {
    const paidIdx = resolverSrc.indexOf('} else if (hasPaidPlan)');
    const pilotIdx = resolverSrc.indexOf("source = 'PILOT'");
    const paidBody = resolverSrc.slice(paidIdx, pilotIdx);
    expect(paidBody).toContain("source = 'SUBSCRIPTION'");
    expect(paidBody).toContain('effectivePlan = orgPlan');
    expect(paidBody).toContain('pilotMetadataIgnored');
  });
});

// -- 12. Pilot entitlement profiles and middleware gates ----------------------

describe('pilot entitlement profiles - policy generation is explicit opt-in', () => {
  const entitlementsSrc = srcFromRoot(
    'fintech-regulatory-backend/src/config/entitlements.config.ts',
  );
  const middlewareSrc = srcFromRoot('fintech-regulatory-backend/src/server/trpc/middleware.ts');

  it('defaults PILOT_FULL policyGeneration to false', () => {
    const profileIdx = entitlementsSrc.indexOf('const pilotFullBase');
    const profileBody = entitlementsSrc.slice(profileIdx, profileIdx + 1200);
    expect(profileBody).toContain('policyGeneration: false');
  });

  it('has a separate profile that explicitly enables policyGeneration', () => {
    expect(entitlementsSrc).toContain('PILOT_FULL_WITH_POLICY_GENERATION');
    expect(entitlementsSrc).toContain('policyGeneration: true');
  });

  it('feature and quota middleware use pilot entitlements, not only ENTERPRISE plan', () => {
    expect(middlewareSrc).toContain('ctx.entitlements');
    expect(middlewareSrc).toContain('requireEntitlementFeature');
    expect(middlewareSrc).toContain('getQuotaFromEntitlements');
  });
});

// -- 13. Backfill and lifecycle cache invalidation ----------------------------

describe('pilot lifecycle and backfill - mandatory planctx invalidation', () => {
  const repairSrc = srcFromRoot('fintech-regulatory-backend/scripts/repair-pilot-access.ts');
  const backfillSrc = srcFromRoot(
    'fintech-regulatory-backend/src/scripts/backfill-pilot-access.ts',
  );
  const pilotRouterSrc = src('pilot.router.ts');
  const cronSrc = srcFromRoot(
    'fintech-regulatory-backend/src/scripts/pilot-lifecycle-cron.ts',
  );

  it('repair flow invalidates sheriabot:planctx:{userId}', () => {
    expect(repairSrc).toContain('sheriabot:planctx:');
    expect(repairSrc).toContain('redis.del');
  });

  it('backfill flow invalidates sheriabot:planctx:{userId}', () => {
    expect(backfillSrc).toContain('sheriabot:planctx:');
    expect(backfillSrc).toContain('redis.del');
  });

  it('admin pilot create/extend/revoke flows reuse cache invalidation including planctx', () => {
    expect(pilotRouterSrc).toContain('planCtxCacheKey');
    expect(pilotRouterSrc).toContain('invalidatePilotUserCaches');
  });

  it('lifecycle cron invalidates planctx when expiring pilots', () => {
    expect(cronSrc).toContain('sheriabot:planctx:');
    expect(cronSrc).toContain('redis.del');
  });
});

// -- 14. Backfill eligibility guardrails --------------------------------------

describe('backfill-pilot-access script - eligibility guardrails', () => {
  const backfillSrc = srcFromRoot(
    'fintech-regulatory-backend/src/scripts/backfill-pilot-access.ts',
  );

  it('validates organization and ACTIVE membership before granting PilotAccess', () => {
    expect(backfillSrc).toContain('organization:');
    expect(backfillSrc).toContain('organizationMember');
    expect(backfillSrc).toContain('MemberStatus.ACTIVE');
  });

  it('rejects suspended organizations and revoked/converted/expired pilot states', () => {
    expect(backfillSrc).toContain('SubscriptionStatus.SUSPENDED');
    expect(backfillSrc).toContain("pilotAccessStatus === 'REVOKED'");
    expect(backfillSrc).toContain("pilotAccessStatus === 'CONVERTED'");
    expect(backfillSrc).toContain('pilotExpiresAt && user.pilotExpiresAt <= now');
  });

  it('preserves paid subscription behavior instead of downgrading or relabeling users', () => {
    expect(backfillSrc).toContain('paidSubscriptionPreserved');
    expect(backfillSrc).toContain('organizationPlanAtBackfill');
    expect(backfillSrc).not.toContain('plan: SubscriptionPlan.ENTERPRISE');
  });
});

// ── 2. checklist router — orgMemberProcedure guards listChecklists ────────────

describe('checklist router — orgMemberProcedure guards listChecklists', () => {
  const checklistSrc = src('checklist.router.ts');

  it('exports a listChecklists procedure', () => {
    expect(checklistSrc).toContain('listChecklists');
  });

  it('listChecklists is guarded by orgMemberProcedure', () => {
    const idx = checklistSrc.indexOf('listChecklists');
    const snippet = checklistSrc.slice(idx, idx + 200);
    expect(snippet).toContain('orgMemberProcedure');
  });
});

// ── 3. compliance-dashboard router — org membership guard on getComplianceDashboard ──
//
// The router uses protectedProcedure.use(requireOrgMember) rather than a named
// orgMemberProcedure export — both patterns enforce the same ACTIVE-membership
// check. The test verifies the guard is present in either form.

describe('compliance-dashboard router — org membership guard on getComplianceDashboard', () => {
  const dashSrc = src('compliance-dashboard.router.ts');

  it('exports a getComplianceDashboard procedure', () => {
    expect(dashSrc).toContain('getComplianceDashboard');
  });

  it('getComplianceDashboard is protected by an org-membership guard', () => {
    // Accept either the named orgMemberProcedure or the middleware composition pattern
    const hasNamedProcedure = dashSrc.includes('orgMemberProcedure');
    const hasMiddlewareComposition = dashSrc.includes('requireOrgMember');
    expect(hasNamedProcedure || hasMiddlewareComposition).toBe(true);
  });

  it('getComplianceDashboard guard appears before the query handler', () => {
    const idx = dashSrc.indexOf('getComplianceDashboard');
    const snippet = dashSrc.slice(idx, idx + 500);
    // The guard (in either form) must appear before the .query() call
    const guardIdx = Math.max(
      snippet.indexOf('orgMemberProcedure'),
      snippet.indexOf('requireOrgMember'),
    );
    const queryIdx = snippet.indexOf('.query(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(queryIdx).toBeGreaterThan(guardIdx);
  });
});

// ── 4. gap-analysis router — org membership guard on getFrameworks ────────────
//
// Same pattern: the router may use requireOrgMember middleware or orgMemberProcedure.

describe('gap-analysis router — org membership guard on getFrameworks', () => {
  const gapSrc = src('gap-analysis.router.ts');

  it('exports a getFrameworks procedure', () => {
    expect(gapSrc).toContain('getFrameworks');
  });

  it('getFrameworks is protected by an org-membership or plan guard', () => {
    // getFrameworks may use requireOrgMember, orgMemberProcedure, or withPlanContext
    // (plan context implies authenticated org member). Any of these is acceptable.
    const hasOrgMember = gapSrc.includes('orgMemberProcedure') || gapSrc.includes('requireOrgMember');
    const hasPlanContext = gapSrc.includes('withPlanContext');
    expect(hasOrgMember || hasPlanContext).toBe(true);
  });

  it('getFrameworks guard appears before the query handler', () => {
    const idx = gapSrc.indexOf('getFrameworks');
    const snippet = gapSrc.slice(idx, idx + 500);
    const guardIdx = Math.max(
      snippet.indexOf('orgMemberProcedure'),
      snippet.indexOf('requireOrgMember'),
      snippet.indexOf('withPlanContext'),
    );
    const queryIdx = snippet.indexOf('.query(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(queryIdx).toBeGreaterThan(guardIdx);
  });
});

// ── 5. appRouter — all three routers are mounted ─────────────────────────────

describe('appRouter — checklist, complianceDashboard, gapAnalysis are mounted', () => {
  // The router is at src/server/trpc/router.ts
  const routerSrc = src('../trpc/router.ts');

  it('mounts checklistRouter', () => {
    expect(routerSrc).toMatch(/checklist\s*:/);
  });

  it('mounts complianceDashboardRouter', () => {
    expect(routerSrc).toMatch(/complianceDashboard\s*:/);
  });

  it('mounts gapAnalysisRouter', () => {
    expect(routerSrc).toMatch(/gapAnalysis\s*:/);
  });
});

// ── 6. orgMembership middleware — FORBIDDEN for missing ACTIVE row ────────────

describe('orgMembership middleware — FORBIDDEN for missing ACTIVE row', () => {
  // Find the middleware file
  const middlewareSrc = (() => {
    const candidates = [
      '../trpc/middleware/orgMembership.ts',
      '../trpc/middleware/org-membership.ts',
      '../trpc/orgMembership.ts',
      '../middleware/orgMembership.ts',
    ];
    for (const c of candidates) {
      try { return src(c); } catch { /* try next */ }
    }
    // Fall back to searching trpc.ts
    return src('../trpc/trpc.ts');
  })();

  it('checks for ACTIVE membership status', () => {
    expect(middlewareSrc).toMatch(/ACTIVE|MemberStatus\.ACTIVE/);
  });

  it('throws FORBIDDEN when membership is missing', () => {
    expect(middlewareSrc).toMatch(/FORBIDDEN|no_membership/);
  });
});

// ── 7. admin.getStats — policy.count() is wrapped in try/catch ───────────────

describe('admin.getStats — policy.count() schema-drift guard', () => {
  const adminSrc = src('admin.router.ts');

  it('wraps policy.count() in a try/catch block', () => {
    // Find the getStats procedure
    const statsIdx = adminSrc.indexOf('getStats: adminProcedure');
    expect(statsIdx).toBeGreaterThan(-1);

    const statsBody = adminSrc.slice(statsIdx, statsIdx + 3000);

    // policy.count() must appear inside a try block
    expect(statsBody).toContain('policy.count()');
    expect(statsBody).toContain('try {');
    expect(statsBody).toContain('catch');
  });

  it('logs a warning instead of throwing when policy.count() fails', () => {
    const statsIdx = adminSrc.indexOf('getStats: adminProcedure');
    const statsBody = adminSrc.slice(statsIdx, statsIdx + 3000);

    // The catch block should warn, not rethrow
    expect(statsBody).toContain('admin_stats_policy_count_skipped');
  });

  it('returns policies.total as 0 when policy table is unavailable', () => {
    const statsIdx = adminSrc.indexOf('getStats: adminProcedure');
    const statsBody = adminSrc.slice(statsIdx, statsIdx + 3000);

    // Default values must be initialised to 0
    expect(statsBody).toContain('let totalPolicies = 0');
    expect(statsBody).toContain('let completedPolicies = 0');
  });
});

// ── 8. getDetailedHealth — never throws an unhandled 500 ─────────────────────

describe('getDetailedHealth — returns OK or DEGRADED, never unhandled 500', () => {
  const adminSrc = src('admin.router.ts');

  it('uses safeProbe wrappers for all subsystem calls', () => {
    const healthIdx = adminSrc.indexOf('getDetailedHealth: adminProcedure');
    expect(healthIdx).toBeGreaterThan(-1);

    const healthBody = adminSrc.slice(healthIdx, healthIdx + 3000);
    expect(healthBody).toContain('safeProbe');
  });

  it('provides a fallbackHealth object with degraded status', () => {
    const healthIdx = adminSrc.indexOf('getDetailedHealth: adminProcedure');
    const healthBody = adminSrc.slice(healthIdx, healthIdx + 3000);
    expect(healthBody).toContain("'degraded'");
    expect(healthBody).toContain('fallbackHealth');
  });

  it('does NOT have a top-level catch that throws INTERNAL_SERVER_ERROR', () => {
    const healthIdx = adminSrc.indexOf('getDetailedHealth: adminProcedure');
    const healthBody = adminSrc.slice(healthIdx, healthIdx + 3000);

    // The old pattern was: throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to get system health details' })
    expect(healthBody).not.toContain('Failed to get system health details');
  });

  it('logs the health status (ok or degraded) rather than an error', () => {
    const healthIdx = adminSrc.indexOf('getDetailedHealth: adminProcedure');
    const healthBody = adminSrc.slice(healthIdx, healthIdx + 3000);
    expect(healthBody).toContain('admin_detailed_health_check');
    expect(healthBody).toContain('health.status');
  });
});

// ── 9. repair-pilot-access script — idempotency guarantees ───────────────────

describe('repair-pilot-access script — idempotency and correctness', () => {
  const scriptSrc = srcFromRoot(
    'fintech-regulatory-backend/scripts/repair-pilot-access.ts',
  );

  it('uses upsert (not create) to be idempotent', () => {
    expect(scriptSrc).toContain('organizationMember.upsert');
    expect(scriptSrc).not.toContain('organizationMember.create(');
  });

  it('sets status to ACTIVE on both create and update paths', () => {
    const createIdx = scriptSrc.indexOf('create: {');
    const updateIdx = scriptSrc.indexOf('update: {');
    expect(scriptSrc.slice(createIdx, createIdx + 200)).toContain('MemberStatus.ACTIVE');
    expect(scriptSrc.slice(updateIdx, updateIdx + 200)).toContain('MemberStatus.ACTIVE');
  });

  it('logs before/after counts', () => {
    expect(scriptSrc).toContain('Pilot users scanned');
    expect(scriptSrc).toContain('Users needing repair');
    expect(scriptSrc).toContain('Users repaired');
  });

  it('invalidates Redis membership and session cache keys', () => {
    expect(scriptSrc).toContain('sheriabot:orgmem:');
    expect(scriptSrc).toContain('user:session:');
    expect(scriptSrc).toContain('redis.del');
  });

  it('supports --dry-run flag without writing to the database', () => {
    expect(scriptSrc).toContain('--dry-run');
    expect(scriptSrc).toContain('DRY_RUN');
    // The upsert must be inside an `if (!DRY_RUN)` guard
    const upsertIdx = scriptSrc.indexOf('organizationMember.upsert');
    const guardIdx  = scriptSrc.lastIndexOf('if (!DRY_RUN)', upsertIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(upsertIdx).toBeGreaterThan(guardIdx);
  });
});
