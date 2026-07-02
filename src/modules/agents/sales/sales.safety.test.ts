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

describe('sales agent safety wiring', () => {
  const salesDir = resolve(__dirname);
  const salesSource = filesUnder(salesDir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  const agentsRouterSource = readFileSync(resolve(__dirname, '..', '..', '..', 'server', 'routers', 'agents.router.ts'), 'utf8');

  it('adds only named sales capabilities for draft create/read', () => {
    expect(AGENT_CAPABILITIES).toContain('agents.sales.draft.create');
    expect(AGENT_CAPABILITIES).toContain('agents.sales.draft.read');
  });

  it('does not call Organization, User, PilotAccess, CRM, or send/email write paths from the sales agent module', () => {
    expect(salesSource).not.toContain('organization.update(');
    expect(salesSource).not.toContain('organization.create(');
    expect(salesSource).not.toContain('organization.delete(');
    expect(salesSource).not.toContain('user.update(');
    expect(salesSource).not.toContain('user.create(');
    expect(salesSource).not.toContain('user.delete(');
    expect(salesSource).not.toContain('pilotAccess.update(');
    expect(salesSource).not.toContain('pilotAccess.create(');
    expect(salesSource).not.toContain('pilotAccess.delete(');
    expect(salesSource).not.toContain('campaignService');
    expect(salesSource).not.toContain('sendQueueService');
    expect(salesSource).not.toContain('requestSendConfirmation');
    expect(salesSource).not.toContain('executeSend');
    expect(salesSource).not.toContain('suppress(');
    expect(salesSource).not.toContain('recordConsent');
    expect(salesSource).not.toContain('sendEmail(');
    expect(salesSource).not.toContain('resend.emails');
  });

  it('does not call PostHog capture, identify, or any tracking/write method', () => {
    expect(salesSource).not.toContain('.capture(');
    expect(salesSource).not.toContain('.identify(');
    expect(salesSource).not.toContain('.groupIdentify(');
    expect(salesSource).not.toContain('.alias(');
    expect(salesSource).not.toContain('posthog-node');
  });

  it('only reads RegulatorySignal, Organization, and PilotAccess via SELECT (no INSERT/UPDATE/DELETE in raw SQL)', () => {
    expect(salesSource).not.toMatch(/\$executeRaw/);
    expect(salesSource).not.toMatch(/INSERT INTO/i);
    expect(salesSource).not.toMatch(/UPDATE\s+"(Organization|User|PilotAccess)"/i);
    expect(salesSource).not.toMatch(/DELETE FROM/i);
  });

  it('keeps reviewDraft on human adminProcedure, not agentProcedure', () => {
    expect(agentsRouterSource).toContain('runDrafting: agentProcedure(\'agents.sales.draft.create\')');
    expect(agentsRouterSource).toContain('listDrafts: agentProcedure(\'agents.sales.draft.read\')');
    expect(agentsRouterSource).toContain('getDraft: agentProcedure(\'agents.sales.draft.read\')');
    const salesBlockStart = agentsRouterSource.indexOf('sales: router({');
    const salesBlock = agentsRouterSource.slice(salesBlockStart);
    expect(salesBlock).toMatch(/reviewDraft:\s+adminProcedure/);
    expect(salesBlock).not.toMatch(/reviewDraft:\s+agentProcedure/);
  });
});
