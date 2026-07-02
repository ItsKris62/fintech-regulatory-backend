import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_CREDENTIAL_HEADER, AGENT_CREDENTIAL_HEADER_DISPLAY } from '@/modules/agents/agent-credential.service';

describe('agentProcedure wiring', () => {
  const trpcSource = readFileSync(resolve(__dirname, 'trpc.ts'), 'utf8');
  const middlewareSource = readFileSync(resolve(__dirname, 'middleware.ts'), 'utf8');
  const routerSource = readFileSync(resolve(__dirname, 'router.ts'), 'utf8');

  it('uses a typed X-Agent-Credential header constant and fail-closed rate limiting', () => {
    expect(AGENT_CREDENTIAL_HEADER).toBe('x-agent-credential');
    expect(AGENT_CREDENTIAL_HEADER_DISPLAY).toBe('X-Agent-Credential');
    expect(middlewareSource).toContain('ctx.req.headers[AGENT_CREDENTIAL_HEADER]');
    expect(middlewareSource).toContain("rateLimiter.check(identifier, 'agent-auth', 20, 60, { failClosed: true })");
  });

  it('is deny-by-default and audits denied capabilities', () => {
    expect(trpcSource).toContain('export const agentProcedure = (capability: AgentCapability) =>');
    expect(middlewareSource).toContain('!isAgentCapability(capability)');
    expect(middlewareSource).toContain("action: 'authorization.denied'");
  });

  it('registers agentsRouter in appRouter', () => {
    expect(routerSource).toContain("import { agentsRouter } from '../routers/agents.router';");
    expect(routerSource).toMatch(/\bagents:\s*agentsRouter\b/);
  });
});