import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function src(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('adminMarketing.router previewDynamic', () => {
  const routerSrc = src('adminMarketing.router.ts');

  it('delegates to the shared buildDynamicContactWhere builder instead of a hand-rolled field allowlist', () => {
    expect(routerSrc).toContain("import { buildDynamicContactWhere } from '@/modules/marketing/list.service';");
    expect(routerSrc).toMatch(/previewDynamic:\s*adminProcedure/);
    expect(routerSrc).toContain('buildDynamicContactWhere(input.filterCriteria as Prisma.ContactWhereInput)');
  });

  it('no longer hand-interprets individual filterCriteria keys (the fixed allowlist bug)', () => {
    expect(routerSrc).not.toContain("criteria['consentStatus']");
    expect(routerSrc).not.toContain("criteria['suppressedAt']");
    expect(routerSrc).not.toContain("criteria['companyId']");
    expect(routerSrc).not.toContain("criteria['role']");
  });

  it('logs a Pino type field when previewing a dynamic list', () => {
    expect(routerSrc).toContain("type: 'marketing_list_preview_dynamic'");
  });
});
