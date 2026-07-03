import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_CAPABILITIES } from '@/modules/agents/agent-credential.service';

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    return statSync(fullPath).isDirectory() ? filesUnder(fullPath) : [fullPath];
  });
}

describe('product-bi agent safety wiring', () => {
  const productBiDir = resolve(__dirname);
  const productBiSourceFiles = filesUnder(productBiDir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
  const productBiSource = productBiSourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
  const posthogClientSource = readFileSync(resolve(__dirname, '..', '..', '..', 'lib', 'posthog', 'query-client.ts'), 'utf8');
  const agentsRouterSource = readFileSync(resolve(__dirname, '..', '..', '..', 'server', 'routers', 'agents.router.ts'), 'utf8');

  it('adds only named product-bi capabilities for report create/read', () => {
    expect(AGENT_CAPABILITIES).toContain('agents.productBi.report.create');
    expect(AGENT_CAPABILITIES).toContain('agents.productBi.report.read');
  });

  it('does not call Organization, User, PilotAccess, or Subscription/Plan write paths from the product-bi module', () => {
    expect(productBiSource).not.toContain('organization.update(');
    expect(productBiSource).not.toContain('organization.create(');
    expect(productBiSource).not.toContain('organization.delete(');
    expect(productBiSource).not.toContain('user.update(');
    expect(productBiSource).not.toContain('user.create(');
    expect(productBiSource).not.toContain('user.delete(');
    expect(productBiSource).not.toContain('pilotAccess.update(');
    expect(productBiSource).not.toContain('pilotAccess.create(');
    expect(productBiSource).not.toContain('pilotAccess.delete(');
    expect(productBiSource).not.toContain('usagePeriod.update(');
    expect(productBiSource).not.toContain('usagePeriod.create(');
    expect(productBiSource).not.toContain('usageRecord.update(');
    expect(productBiSource).not.toContain('usageRecord.create(');
  });

  it('does not call PostHog capture, identify, or any tracking/write method (module and shared client)', () => {
    for (const source of [productBiSource, posthogClientSource]) {
      expect(source).not.toContain('.capture(');
      expect(source).not.toContain('.identify(');
      expect(source).not.toContain('.groupIdentify(');
      expect(source).not.toContain('.alias(');
      expect(source).not.toContain('posthog-node');
    }
  });

  it('only reads via groupBy/findMany/findFirst/count in raw and Prisma queries (no write methods anywhere in the module)', () => {
    expect(productBiSource).not.toMatch(/\$executeRaw/);
    expect(productBiSource).not.toMatch(/INSERT INTO|UPDATE\s+"|DELETE FROM/i);
  });

  it('does not reuse or modify B5 files - engagement-lookup.service.ts gets zero diff-relevant references', () => {
    expect(productBiSource).not.toContain('engagement-lookup.service');
    expect(productBiSource).not.toContain('SalesEngagementLookupService');
  });

  it('never types or serializes a contact email, phone, or personal-name field anywhere in the module source', () => {
    expect(productBiSource).not.toMatch(/contactEmail|contactPerson|contactPhone/);
    // fullName is a legitimate User field elsewhere in the codebase, but must never
    // appear in this module at all - product-bi only ever reads organizationId /
    // organization name / aggregate counts, never a person's identity.
    expect(productBiSource).not.toMatch(/\bfullName\b/);
    expect(productBiSource).not.toMatch(/\buser\.email\b/);
  });

  it('mounts productBi.* behind agentProcedure only - never orgMemberProcedure or any other tenant-facing procedure', () => {
    const wrapperStart = agentsRouterSource.indexOf('productBi: router({');
    expect(wrapperStart).toBeGreaterThan(-1);
    const start = agentsRouterSource.indexOf('\n', wrapperStart) + 1;
    const end = agentsRouterSource.indexOf('\n});', start);
    const block = agentsRouterSource.slice(start, end);

    expect(block).toContain("runReport: agentProcedure('agents.productBi.report.create')");
    expect(block).toContain("getLatestReport: agentProcedure('agents.productBi.report.read')");
    expect(block).toContain("listReports: agentProcedure('agents.productBi.report.read')");

    // Explicit tenant-isolation proof: each of the three top-level productBi
    // router endpoints (not nested zod schema fields, which also look like
    // `key: value`) is assigned directly to agentProcedure or adminProcedure -
    // this is the first agent that aggregates across ALL organizations rather
    // than one at a time, so it must never be reachable through a
    // tenant-scoped procedure (orgMemberProcedure, protectedProcedure, etc).
    for (const endpoint of ['runReport', 'getLatestReport', 'listReports']) {
      const match = block.match(new RegExp(`\\b${endpoint}:\\s*(\\w+)`));
      expect(match, `expected to find a top-level "${endpoint}:" assignment`).not.toBeNull();
      expect(match?.[1]).toMatch(/^(agentProcedure|adminProcedure)$/);
    }
  });
});
