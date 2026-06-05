import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { SubscriptionPlan } from '@prisma/client';
import {
  allowedFrameworkTiersForPlan,
  canAccessFrameworkTier,
} from '../services/framework-access.service';

function src(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

function platformSrc(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), '..', 'fintech-regulatory-platform', relativePath), 'utf8');
}

describe('framework access helpers', () => {
  it('allows Startup to see only basic framework tiers', () => {
    expect(allowedFrameworkTiersForPlan(SubscriptionPlan.STARTUP)).toEqual(['STARTUP']);
    expect(canAccessFrameworkTier(SubscriptionPlan.STARTUP, 'STARTUP')).toBe(true);
    expect(canAccessFrameworkTier(SubscriptionPlan.STARTUP, 'BUSINESS')).toBe(false);
    expect(canAccessFrameworkTier(SubscriptionPlan.STARTUP, 'ENTERPRISE')).toBe(false);
  });

  it('allows Business to see Startup and Business framework tiers', () => {
    expect(allowedFrameworkTiersForPlan(SubscriptionPlan.BUSINESS)).toEqual(['STARTUP', 'BUSINESS']);
    expect(canAccessFrameworkTier(SubscriptionPlan.BUSINESS, 'STARTUP')).toBe(true);
    expect(canAccessFrameworkTier(SubscriptionPlan.BUSINESS, 'BUSINESS')).toBe(true);
    expect(canAccessFrameworkTier(SubscriptionPlan.BUSINESS, 'ENTERPRISE')).toBe(false);
  });

  it('allows Enterprise and active pilots with Enterprise effective plan to see Enterprise framework tiers', () => {
    expect(allowedFrameworkTiersForPlan(SubscriptionPlan.ENTERPRISE)).toEqual(['STARTUP', 'BUSINESS', 'ENTERPRISE']);
    expect(canAccessFrameworkTier(SubscriptionPlan.ENTERPRISE, 'ENTERPRISE')).toBe(true);
  });

  it('falls back expired or revoked pilots to the paid/free effective plan before framework access is evaluated', () => {
    expect(canAccessFrameworkTier(SubscriptionPlan.REGULATOR, 'ENTERPRISE')).toBe(false);
    expect(canAccessFrameworkTier(SubscriptionPlan.STARTUP, 'ENTERPRISE')).toBe(false);
    expect(canAccessFrameworkTier(SubscriptionPlan.BUSINESS, 'ENTERPRISE')).toBe(false);
  });
});

describe('framework router source invariants', () => {
  const routerSrc = src('src/server/routers/framework.router.ts');
  const rootRouterSrc = src('src/server/trpc/router.ts');
  const gapRouterSrc = src('src/server/routers/gap-analysis.router.ts');

  it('registers framework.list on the root tRPC router', () => {
    expect(rootRouterSrc).toContain("import { frameworkRouter } from '../routers/framework.router'");
    expect(rootRouterSrc).toContain('framework: frameworkRouter');
  });

  it('hides inactive frameworks from normal users but allows platform admin all-framework listing', () => {
    expect(routerSrc).toContain('includeInactive ? {} : { isActive: true }');
    expect(routerSrc).toContain("ctx.user!.role === 'ADMIN'");
    expect(routerSrc).toContain('input?.includeInactive && isPlatformAdmin');
  });

  it('filters normal framework listing by effective plan tier', () => {
    expect(routerSrc).toContain('allowedFrameworkTiersForPlan(plan)');
    expect(routerSrc).toContain('canAccessFrameworkTier(plan, framework.tier)');
  });

  it('returns metadata only and does not expose legal document content fields', () => {
    const selectBody = routerSrc.slice(routerSrc.indexOf('const frameworkSelect'), routerSrc.indexOf('function toFrameworkMetadata'));
    expect(selectBody).toContain('description: true');
    expect(selectBody).not.toContain('fullText');
    expect(selectBody).not.toContain('content: true');
    expect(selectBody).not.toContain('htmlContent');
  });

  it('keeps gap-analysis framework selection on active frameworks and shared tier locks', () => {
    expect(gapRouterSrc).toContain('where: { isActive: true }');
    expect(gapRouterSrc).toContain('canAccessFrameworkTier(plan, fw.tier)');
    expect(gapRouterSrc).toContain('canAccessFrameworkTier(plan, f.tier)');
    expect(gapRouterSrc).toContain('gapAnalysisFramework.createMany');
  });
});

describe('framework frontend source invariants', () => {
  const listPage = platformSrc('app/(dashboard)/regulator/frameworks/page.tsx');
  const newPage = platformSrc('app/(dashboard)/regulator/frameworks/new/page.tsx');
  const detailPage = platformSrc('app/(dashboard)/regulator/frameworks/[frameworkId]/page.tsx');

  it('uses the real framework listing query instead of static mock frameworks', () => {
    expect(listPage).toContain('trpc.framework.list.useQuery');
    expect(listPage).not.toContain('const frameworks = [');
    expect(listPage).not.toContain('fw-001');
  });

  it('gates custom framework creation and does not submit mock data', () => {
    expect(newPage).toContain('FeatureGate');
    expect(newPage).toContain('feature="customFrameworks"');
    expect(newPage).toContain('Custom framework creation is coming soon');
    expect(newPage).not.toContain('router.push("/regulator/frameworks")');
    expect(newPage).not.toContain('handleSave');
  });

  it('uses real framework detail metadata and avoids fake module data', () => {
    expect(detailPage).toContain('trpc.framework.getBySlug.useQuery');
    expect(detailPage).not.toContain('const frameworkData =');
    expect(detailPage).not.toContain('requirements: [');
  });
});
