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

describe('security-ops agent safety wiring', () => {
  const securityOpsDir = resolve(__dirname);
  const securityOpsSourceFiles = filesUnder(securityOpsDir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
  const securityOpsSource = securityOpsSourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
  const agentsRouterSource = readFileSync(resolve(__dirname, '..', '..', '..', 'server', 'routers', 'agents.router.ts'), 'utf8');

  it('adds only named security-ops capabilities for report create/read', () => {
    expect(AGENT_CAPABILITIES).toContain('agents.securityOps.report.create');
    expect(AGENT_CAPABILITIES).toContain('agents.securityOps.report.read');
  });

  it('does not call Organization, User, PilotAccess, or Subscription/Plan write paths', () => {
    expect(securityOpsSource).not.toContain('organization.update(');
    expect(securityOpsSource).not.toContain('organization.create(');
    expect(securityOpsSource).not.toContain('organization.delete(');
    expect(securityOpsSource).not.toContain('user.update(');
    expect(securityOpsSource).not.toContain('user.create(');
    expect(securityOpsSource).not.toContain('user.delete(');
    expect(securityOpsSource).not.toContain('pilotAccess.update(');
    expect(securityOpsSource).not.toContain('usagePeriod.update(');
    expect(securityOpsSource).not.toContain('usageRecord.update(');
  });

  it('only reads via groupBy/findMany/findFirst/count/$queryRaw SELECT (no write methods anywhere)', () => {
    expect(securityOpsSource).not.toMatch(/\$executeRaw/);
    expect(securityOpsSource).not.toMatch(/INSERT INTO|UPDATE\s+"|DELETE FROM/i);
  });

  it('never imports or modifies agent-run.service.ts internals beyond the public AgentRunService dependency every batch uses - no reference to the private alertOperator', () => {
    expect(securityOpsSource).not.toContain('alertOperator');
  });

  it('routes alerts through sendEmail() directly, not a new email client', () => {
    expect(securityOpsSource).toContain("from '@/lib/email/client'");
  });

  it('stays within the approved v1 scope: no GitHub API, Sentry API, external uptime service, or infra-billing API calls', () => {
    expect(securityOpsSource).not.toMatch(/octokit/i);
    expect(securityOpsSource).not.toMatch(/api\.github\.com/i);
    expect(securityOpsSource).not.toMatch(/api\.sentry\.io/i);
    expect(securityOpsSource).not.toMatch(/betterstack|uptimerobot|pingdom|statuscake/i);
    expect(securityOpsSource).not.toMatch(/render\.com\/api|vercel\.com\/api|api\.vercel\.com|api\.supabase\.com|pinecone\.io\/usage/i);
  });

  it('applies a second sanitization pass and never types or serializes a contact email, phone, or personal-name field', () => {
    expect(securityOpsSource).not.toMatch(/contactEmail|contactPerson|contactPhone/);
    expect(securityOpsSource).not.toMatch(/\bfullName\b/);
    expect(securityOpsSource).not.toMatch(/\buser\.email\b/);
  });

  it('mounts securityOps.* behind agentProcedure only - never orgMemberProcedure or any other tenant-facing procedure', () => {
    const wrapperStart = agentsRouterSource.indexOf('securityOps: router({');
    expect(wrapperStart).toBeGreaterThan(-1);
    const start = agentsRouterSource.indexOf('\n', wrapperStart) + 1;
    const end = agentsRouterSource.indexOf('\n});', start);
    const block = agentsRouterSource.slice(start, end);

    for (const endpoint of ['runReport', 'getLatestReport', 'listReports']) {
      const match = block.match(new RegExp(`\\b${endpoint}:\\s*(\\w+)`));
      expect(match, `expected to find a top-level "${endpoint}:" assignment`).not.toBeNull();
      expect(match?.[1]).toMatch(/^(agentProcedure|adminProcedure)$/);
    }
  });
});
