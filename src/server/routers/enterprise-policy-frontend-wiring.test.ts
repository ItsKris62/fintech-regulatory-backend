import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const repoRoot = resolve(__dirname, '../../../..');
const frontendRoot = resolve(repoRoot, 'fintech-regulatory-platform');

function readFrontend(relativePath: string): string {
  return readFileSync(resolve(frontendRoot, relativePath), 'utf8');
}

describe('Batch 6 enterprise policy frontend wiring invariants', () => {
  const generatorPage = 'app/(dashboard)/regulator/policy-generator/page.tsx';
  const historyPage = 'app/(dashboard)/regulator/policy-generator/history/page.tsx';
  const detailPage = 'app/(dashboard)/regulator/policy-generator/[id]/page.tsx';
  const enterpriseHook = 'hooks/use-enterprise-policies.ts';

  it('visible policy generator pages are gated by policyGeneration', () => {
    for (const page of [generatorPage, historyPage, detailPage]) {
      const source = readFrontend(page);
      expect(source).toContain('FeatureGate');
      expect(source).toContain('feature="policyGeneration"');
      expect(source).toContain('AI Policy Generator is available on Enterprise plans.');
    }
  });

  it('visible policy generator no longer calls the legacy policy router', () => {
    const visibleSources = [
      readFrontend(generatorPage),
      readFrontend(historyPage),
      readFrontend(detailPage),
      readFrontend(enterpriseHook),
    ].join('\n');

    expect(visibleSources).not.toContain('trpc.policy.generate');
    expect(visibleSources).not.toContain('trpc.policy.list');
    expect(visibleSources).not.toContain('trpc.policy.get');
    expect(visibleSources).not.toContain('@/hooks/use-policies');
    expect(visibleSources).toContain('trpc.enterprisePolicy.createDraft');
    expect(visibleSources).toContain('trpc.enterprisePolicy.listPolicies');
    expect(visibleSources).toContain('trpc.enterprisePolicy.getPolicy');
    expect(visibleSources).toContain('trpc.enterprisePolicy.getStatus');
  });

  it('history page uses live data instead of static mock policy history', () => {
    const source = readFrontend(historyPage);
    expect(source).toContain('useEnterprisePolicies');
    expect(source).not.toContain('const policyHistory = [');
    expect(source).not.toContain('pol-001');
    expect(source).toContain('No generated policies yet. Create your first Enterprise policy draft to get started.');
  });

  it('export is not presented as a completed Enterprise policy download', () => {
    const detailSource = readFrontend(detailPage);
    const historySource = readFrontend(historyPage);
    expect(detailSource).toContain('Export coming soon');
    expect(detailSource).not.toContain('enterprisePolicy.exportPolicy.useMutation');
    expect(historySource).not.toContain('Download');
  });

  it('sidebar ties the policy generator route to policyGeneration', () => {
    const source = readFrontend('components/layout/dashboard-sidebar.tsx');
    expect(source).toContain('href: "/regulator/policy-generator"');
    expect(source).toContain('lockedFeature: "policyGeneration"');
  });
});

describe('Batch 6 enterprise policy backend safety invariants', () => {
  const routerSource = readFileSync(resolve(repoRoot, 'fintech-regulatory-backend/src/server/routers/enterprise-policy.router.ts'), 'utf8');

  it('createDraft uses org membership, plan feature, and deferred usage middleware', () => {
    expect(routerSource).toContain('createDraft: orgMemberProcedure');
    expect(routerSource).toContain(".use(requirePlanFeature('policyGeneration'))");
    expect(routerSource).toContain('checkUsageLimit(BillingMetric.POLICY_GENERATIONS, { deferIncrement: true })');
    expect(routerSource).toContain('await ctx.incrementUsage');
  });

  it('enterprise policy read and mutation procedures enforce policyGeneration', () => {
    for (const procedure of ['getStatus', 'getPolicy', 'listPolicies', 'updateSectionContent', 'deletePolicy', 'exportPolicy']) {
      const procedureIndex = routerSource.indexOf(`${procedure}: orgMemberProcedure`);
      expect(procedureIndex, `${procedure} should exist`).toBeGreaterThan(-1);
      const nextProcedureMatch = /[\w]+:\s+orgMemberProcedure/g;
      nextProcedureMatch.lastIndex = procedureIndex + procedure.length;
      const match = nextProcedureMatch.exec(routerSource);
      const body = routerSource.slice(procedureIndex, match?.index);
      expect(body).toContain(".use(requirePlanFeature('policyGeneration'))");
    }
  });

  it('enterprise policy list and detail are organization scoped', () => {
    expect(routerSource).toContain('const organizationId = ctx.orgMembership!.organizationId');
    expect(routerSource).toContain('organizationId,');
    expect(routerSource).toContain('policy.organizationId !== organizationId');
    expect(routerSource).not.toContain('policy.userId !== userId && policy.organizationId !== organizationId');
  });
});
