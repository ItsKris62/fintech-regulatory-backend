import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('checklist router quota hardening', () => {
  const source = readFileSync(resolve(__dirname, 'checklist.router.ts'), 'utf8');

  it('authorizes jurisdiction before reserving async checklist generation quota', () => {
    const asyncStart = source.indexOf('generateChecklistAsync: orgMemberProcedure');
    const jurisdictionResolution = source.indexOf('resolveChecklistJurisdictionContext', asyncStart);
    const quotaResolution = source.indexOf('resolveUsageLimit(ctx, BillingMetric.CHECKLIST_GENERATIONS)', asyncStart);
    const serviceCall = source.indexOf('checklistService.generateChecklist', asyncStart);

    expect(jurisdictionResolution).toBeGreaterThan(asyncStart);
    expect(quotaResolution).toBeGreaterThan(jurisdictionResolution);
    expect(serviceCall).toBeGreaterThan(quotaResolution);
  });
});
