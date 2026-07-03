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

describe('chief-of-staff agent safety wiring', () => {
  const chiefOfStaffDir = resolve(__dirname);
  const chiefOfStaffSourceFiles = filesUnder(chiefOfStaffDir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
  const chiefOfStaffSource = chiefOfStaffSourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
  const agentsRouterSource = readFileSync(resolve(__dirname, '..', '..', '..', 'server', 'routers', 'agents.router.ts'), 'utf8');

  it('adds only named chief-of-staff capabilities for report create/read', () => {
    expect(AGENT_CAPABILITIES).toContain('agents.chiefOfStaff.report.create');
    expect(AGENT_CAPABILITIES).toContain('agents.chiefOfStaff.report.read');
  });

  it('does not call Organization, User, PilotAccess, or Subscription/Plan write paths', () => {
    expect(chiefOfStaffSource).not.toContain('organization.update(');
    expect(chiefOfStaffSource).not.toContain('organization.create(');
    expect(chiefOfStaffSource).not.toContain('organization.delete(');
    expect(chiefOfStaffSource).not.toContain('user.update(');
    expect(chiefOfStaffSource).not.toContain('user.create(');
    expect(chiefOfStaffSource).not.toContain('user.delete(');
    expect(chiefOfStaffSource).not.toContain('pilotAccess.update(');
  });

  it('only reads via findFirst/findMany/count (no write methods anywhere in the module)', () => {
    expect(chiefOfStaffSource).not.toMatch(/\$executeRaw/);
    expect(chiefOfStaffSource).not.toMatch(/INSERT INTO|UPDATE\s+"|DELETE FROM/i);
    expect(chiefOfStaffSource).not.toContain('agentReport.update(');
    expect(chiefOfStaffSource).not.toContain('agentReport.create(');
    expect(chiefOfStaffSource).not.toContain('agentReport.delete(');
  });

  it('never imports another batch\'s agent/service class - reads only via its own Prisma queries against AgentReport/AgentRun', () => {
    expect(chiefOfStaffSource).not.toMatch(/from ['"]@\/modules\/agents\/marketing\//);
    expect(chiefOfStaffSource).not.toMatch(/from ['"]@\/modules\/agents\/sales\//);
    expect(chiefOfStaffSource).not.toMatch(/from ['"]@\/modules\/agents\/product-bi\//);
    expect(chiefOfStaffSource).not.toMatch(/from ['"]@\/modules\/agents\/security-ops\//);
    expect(chiefOfStaffSource).not.toMatch(/from ['"]@\/modules\/agents\/regulatory-intelligence\//);
    expect(chiefOfStaffSource).not.toMatch(/from ['"]@\/modules\/agents\/automation\//);
  });

  it('routes delivery through sendEmail() directly, not security-ops\' ops-alert.service.ts or agent-run.service.ts\'s own alert method', () => {
    expect(chiefOfStaffSource).toContain("from '@/lib/email/client'");
    expect(chiefOfStaffSource).not.toContain('ops-alert.service');
    expect(chiefOfStaffSource).not.toContain('SecurityOpsAlertService');
    expect(chiefOfStaffSource).not.toContain('alertOperator');
  });

  it('every ranked action and decision needed the orchestrator persists traces back to a real source reportId, never a fabricated placeholder', () => {
    expect(chiefOfStaffSource).toContain('brief?.rankedActions ?? []');
    expect(chiefOfStaffSource).toContain('brief?.decisionsNeeded ?? []');
  });

  it('mounts chiefOfStaff.* behind agentProcedure only - never orgMemberProcedure or any other tenant-facing procedure', () => {
    const wrapperStart = agentsRouterSource.indexOf('chiefOfStaff: router({');
    expect(wrapperStart).toBeGreaterThan(-1);
    const start = agentsRouterSource.indexOf('\n', wrapperStart) + 1;
    const end = agentsRouterSource.indexOf('\n});', start);
    const block = agentsRouterSource.slice(start, end);

    for (const endpoint of ['runBrief', 'getLatestReport', 'listReports']) {
      const match = block.match(new RegExp(`\\b${endpoint}:\\s*(\\w+)`));
      expect(match, `expected to find a top-level "${endpoint}:" assignment`).not.toBeNull();
      expect(match?.[1]).toMatch(/^(agentProcedure|adminProcedure)$/);
    }
  });
});
