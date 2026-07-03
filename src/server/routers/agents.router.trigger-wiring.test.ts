import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('scheduler-trigger router wiring (B9)', () => {
  const routerSource = readFileSync(resolve(__dirname, 'agents.router.ts'), 'utf8');

  const TRIGGER_ENDPOINTS: Array<{ startMarker: string; action: string }> = [
    { startMarker: "runScan: agentProcedure('agents.regIntel.run.create')", action: 'agent-trigger-regIntel-runScan' },
    { startMarker: "runDrafting: agentProcedure('agents.marketing.draft.create')", action: 'agent-trigger-marketing-runDrafting' },
    { startMarker: "runDrafting: agentProcedure('agents.sales.draft.create')", action: 'agent-trigger-sales-runDrafting' },
    { startMarker: "runReport: agentProcedure('agents.productBi.report.create')", action: 'agent-trigger-productBi-runReport' },
    { startMarker: "runReport: agentProcedure('agents.securityOps.report.create')", action: 'agent-trigger-securityOps-runReport' },
    { startMarker: "runBrief: agentProcedure('agents.chiefOfStaff.report.create')", action: 'agent-trigger-chiefOfStaff-runBrief' },
  ];

  it.each(TRIGGER_ENDPOINTS)('chains a capability-scoped, shared-config rate limiter onto $startMarker', ({ startMarker, action }) => {
    const start = routerSource.indexOf(startMarker);
    expect(start).toBeGreaterThan(-1);
    const block = routerSource.slice(start, start + 300);

    expect(block).toContain(`rateLimited('${action}', appConfig.agents.trigger.rateLimitMax`);
    expect(block).toContain('window: appConfig.agents.trigger.rateLimitWindowSeconds');
  });

  it('gives regIntel.runScan its own dedicated capability, not the shared agents.run.create beginRun uses', () => {
    expect(routerSource).toContain("runScan: agentProcedure('agents.regIntel.run.create')");
    expect(routerSource).toContain("beginRun: agentProcedure('agents.run.create')");
  });

  it('uses action keys distinct from the shared agent-auth bucket and from the automation buckets', () => {
    for (const { action } of TRIGGER_ENDPOINTS) {
      expect(action.startsWith('agent-trigger-')).toBe(true);
    }
    expect(routerSource).not.toContain("rateLimited('agent-auth'");
    expect(routerSource).not.toContain("rateLimited('automation-log', appConfig.agents.trigger");
  });
});
