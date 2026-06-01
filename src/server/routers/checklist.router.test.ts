import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('checklist router quota hardening', () => {
  const source = readFileSync(resolve(__dirname, 'checklist.router.ts'), 'utf8');

  it('reserves async checklist generation quota before queuing background work', () => {
    const asyncStart = source.indexOf('generateChecklistAsync: orgMemberProcedure');
    const quotaMiddleware = source.indexOf(
      'checkUsageLimit(BillingMetric.CHECKLIST_GENERATIONS))',
      asyncStart,
    );
    const serviceCall = source.indexOf('checklistService.generateChecklist', asyncStart);

    expect(quotaMiddleware).toBeGreaterThan(asyncStart);
    expect(serviceCall).toBeGreaterThan(quotaMiddleware);
    expect(source.slice(asyncStart, serviceCall)).not.toContain('deferIncrement: true');
  });
});
