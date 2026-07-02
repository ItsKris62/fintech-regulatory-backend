import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('automation router rate-limit wiring', () => {
  const routerSource = readFileSync(
    resolve(__dirname, '..', '..', '..', 'server', 'routers', 'agents.router.ts'),
    'utf8',
  );

  it('chains a capability-scoped rate limiter, distinct from the shared agent-auth bucket, onto logEvent', () => {
    const start = routerSource.indexOf("logEvent: agentProcedure('agents.automation.log.create')");
    expect(start).toBeGreaterThan(-1);
    const block = routerSource.slice(start, start + 300);

    expect(block).toContain("rateLimited('automation-log', appConfig.agents.automation.logRateLimitMax");
    expect(block).toContain('window: appConfig.agents.automation.logRateLimitWindowSeconds');
  });

  it('chains a capability-scoped rate limiter, distinct from the shared agent-auth bucket, onto generate', () => {
    const start = routerSource.indexOf("generate: agentProcedure('agents.automation.generate')");
    expect(start).toBeGreaterThan(-1);
    const block = routerSource.slice(start, start + 300);

    expect(block).toContain("rateLimited('automation-generate', appConfig.agents.automation.generateRateLimitMax");
    expect(block).toContain('window: appConfig.agents.automation.generateRateLimitWindowSeconds');
  });

  it('uses action keys distinct from the shared agent-auth bucket used by requireAgentCapability', () => {
    const middlewareSource = readFileSync(
      resolve(__dirname, '..', '..', '..', 'server', 'trpc', 'middleware.ts'),
      'utf8',
    );
    expect(middlewareSource).toContain("rateLimiter.check(identifier, 'agent-auth', 20, 60, { failClosed: true })");
    expect(routerSource).not.toContain("rateLimited('agent-auth'");
  });
});
