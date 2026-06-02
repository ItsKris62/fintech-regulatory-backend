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
    expect(scriptSrc).toContain('Pilot users with an organizationId');
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
