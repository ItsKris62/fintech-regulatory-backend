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

  it('chains a capability-scoped rate limiter, distinct from the shared agent-auth bucket, onto getMetrics', () => {
    const start = routerSource.indexOf("getMetrics: agentProcedure('agents.automation.metrics.read')");
    expect(start).toBeGreaterThan(-1);
    const block = routerSource.slice(start, start + 300);

    expect(block).toContain("rateLimited('automation-metrics', appConfig.agents.automation.metricsRateLimitMax");
    expect(block).toContain('window: appConfig.agents.automation.metricsRateLimitWindowSeconds');
  });

  it('chains a capability-scoped rate limiter onto createApproval and getApproval', () => {
    const createStart = routerSource.indexOf("createApproval: agentProcedure('agents.automation.approval.create')");
    expect(createStart).toBeGreaterThan(-1);
    expect(routerSource.slice(createStart, createStart + 300)).toContain("rateLimited('automation-approval-create', appConfig.agents.automation.approvalCreateRateLimitMax");

    const readStart = routerSource.indexOf("getApproval: agentProcedure('agents.automation.approval.read')");
    expect(readStart).toBeGreaterThan(-1);
    expect(routerSource.slice(readStart, readStart + 300)).toContain("rateLimited('automation-approval-read', appConfig.agents.automation.approvalReadRateLimitMax");
  });

  it('routes recordApprovalDecision through adminProcedure, not agentProcedure - it is a human decision, not an n8n-triggered one', () => {
    const start = routerSource.indexOf('recordApprovalDecision:');
    expect(start).toBeGreaterThan(-1);
    const block = routerSource.slice(start, start + 120);
    expect(block).toContain('adminProcedure');
    expect(block).not.toContain('agentProcedure');
  });

  it('derives recordApprovalDecision\'s `by` from the session, never a client-supplied field', () => {
    const start = routerSource.indexOf('recordApprovalDecision:');
    const block = routerSource.slice(start, start + 600);
    expect(block).toContain('ctx.user!.id');
    expect(block).not.toMatch(/decision:\s*z\.enum\(\['approved', 'rejected'\]\),\s*by:/);
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
