import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('appRouter critical feature mounts', () => {
  const routerSource = readFileSync(resolve(__dirname, 'router.ts'), 'utf8');

  it('registers dashboard, checklist, and gap-analysis routers at the root', () => {
    expect(routerSource).toContain("import { checklistRouter } from '../routers/checklist.router';");
    expect(routerSource).toContain("import { complianceDashboardRouter } from '../routers/compliance-dashboard.router';");
    expect(routerSource).toContain("import { gapAnalysisRouter } from '../routers/gap-analysis.router';");
    expect(routerSource).toMatch(/\bchecklist:\s*checklistRouter\b/);
    expect(routerSource).toMatch(/\bcomplianceDashboard:\s*complianceDashboardRouter\b/);
    expect(routerSource).toMatch(/\bgapAnalysis:\s*gapAnalysisRouter\b/);
  });

  it('documents the tRPC namespaces consumed by the dashboard UI', () => {
    expect(routerSource).toContain('/trpc/checklist.*');
    expect(routerSource).toContain('/trpc/complianceDashboard.*');
    expect(routerSource).toContain('/trpc/gapAnalysis.*');
  });
});
