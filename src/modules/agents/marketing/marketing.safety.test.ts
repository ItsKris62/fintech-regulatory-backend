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

describe('marketing agent safety wiring', () => {
  const marketingDir = resolve(__dirname);
  const marketingSource = filesUnder(marketingDir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  const agentsRouterSource = readFileSync(resolve(__dirname, '..', '..', '..', 'server', 'routers', 'agents.router.ts'), 'utf8');

  it('adds only named marketing capabilities for draft create/read', () => {
    expect(AGENT_CAPABILITIES).toContain('agents.marketing.draft.create');
    expect(AGENT_CAPABILITIES).toContain('agents.marketing.draft.read');
  });

  it('does not call Campaign, send, suppression, or consent write paths from the marketing agent module', () => {
    expect(marketingSource).not.toContain('campaignService');
    expect(marketingSource).not.toContain('sendQueueService');
    expect(marketingSource).not.toContain('requestSendConfirmation');
    expect(marketingSource).not.toContain('executeSend');
    expect(marketingSource).not.toContain('suppress(');
    expect(marketingSource).not.toContain('recordConsent');
    expect(marketingSource).not.toContain('marketingCampaign.');
    expect(marketingSource).not.toContain('campaignSend.');
  });

  it('keeps reviewDraft on human adminProcedure, not agentProcedure', () => {
    expect(agentsRouterSource).toContain('runDrafting: agentProcedure(\'agents.marketing.draft.create\')');
    expect(agentsRouterSource).toContain('listDrafts: agentProcedure(\'agents.marketing.draft.read\')');
    expect(agentsRouterSource).toContain('getDraft: agentProcedure(\'agents.marketing.draft.read\')');
    expect(agentsRouterSource).toMatch(/reviewDraft:\s+adminProcedure/);
    expect(agentsRouterSource).not.toMatch(/reviewDraft:\s+agentProcedure/);
  });
});