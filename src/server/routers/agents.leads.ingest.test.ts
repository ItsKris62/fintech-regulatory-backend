import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('agents.marketing.leads Ingestion Wiring & Security Architecture (P0)', () => {
  const routerPath = join(__dirname, 'agents.router.ts');
  const routerSrc = readFileSync(routerPath, 'utf8');

  it('wires leads ingestion sub-router under machine agentsRouter.marketing', () => {
    expect(routerSrc).toContain('leads: router({');
    expect(routerSrc).toContain("initDiscoveryRun: agentProcedure('agents.marketing.leads.ingest')");
    expect(routerSrc).toContain("ingestBatch: agentProcedure('agents.marketing.leads.ingest')");
    expect(routerSrc).toContain("completeDiscoveryRun: agentProcedure('agents.marketing.leads.ingest')");
  });

  it('applies strict Zod validations for untrusted AI output (Amendment 16 & 17)', () => {
    expect(routerSrc).toContain('safeUrlSchema');
    expect(routerSrc).toContain('candidateLeadSchema');
    expect(routerSrc).toContain('evidenceItemSchema');
    expect(routerSrc).toContain('z.array(candidateLeadSchema).min(1).max(50)');
  });
});
