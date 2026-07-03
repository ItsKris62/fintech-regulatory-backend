import { describe, expect, it, vi } from 'vitest';
import type { LLMCompletionRequest } from '@/lib/ai/gateway/types';
import { SecurityOpsAlertSynthesisService } from './alert-synthesis.service';
import type { GroundedOpsSnapshot } from './types';

function snapshot(): GroundedOpsSnapshot {
  return {
    version: 1,
    windowStart: '2026-07-02T00:00:00.000Z',
    windowEnd: '2026-07-03T00:00:00.000Z',
    workforceCosts: [{
      agentType: 'sales-growth', totalCostUsd: 0.8, totalInputTokens: 400, totalOutputTokens: 200,
      runCount: 5, completedCount: 3, failedCount: 0, haltedBudgetCount: 2, haltedIterationsCount: 0,
    }],
    serviceHealth: [
      { service: 'database', status: 'down' },
      { service: 'redis', status: 'healthy', latencyMs: 12 },
    ],
    errorSummary: {
      totalUniqueErrors: 2,
      topErrors: [{ code: 'DB_TIMEOUT', count: 14, message: 'Database error' }],
    },
  };
}

describe('SecurityOpsAlertSynthesisService', () => {
  it('uses Claude only and sends a source-only grounded prompt', async () => {
    const requests: LLMCompletionRequest[] = [];
    const complete = vi.fn(async (request: LLMCompletionRequest) => {
      requests.push(request);
      return {
        content: JSON.stringify({
          summary: 'Database check reported down this window; sales-growth had 2 halted-budget runs.',
          risks: ['database check reported status: down', 'sales-growth had 2 HALTED_BUDGET runs this window'],
        }),
        provider: 'anthropic' as const,
        model: 'claude-opus-4-6',
        usage: { inputTokens: 150, outputTokens: 80 },
        stopReason: 'end_turn',
      };
    });
    const service = new SecurityOpsAlertSynthesisService({ llmGateway: { complete } });

    await service.synthesize(snapshot());

    expect(requests[0]).toMatchObject({ provider: 'anthropic', allowFallback: false, useCase: 'analysis' });
    expect(requests[0].systemPrompt).toContain('evidence over summary');
    expect(requests[0].systemPrompt).toContain('Never invent a status, latency figure, error count, or cost');
    expect(requests[0].systemPrompt).toContain('PII minimization rule');
    expect(requests[0].prompt).toContain('DB_TIMEOUT');
  });

  it('never sends a PII-shaped field in the prompt payload', async () => {
    const complete = vi.fn(async (_request: LLMCompletionRequest) => ({
      content: JSON.stringify({ summary: 'ok', risks: [] }),
      provider: 'anthropic' as const,
      model: 'claude-opus-4-6',
      usage: { inputTokens: 40, outputTokens: 10 },
      stopReason: 'end_turn',
    }));
    const service = new SecurityOpsAlertSynthesisService({ llmGateway: { complete } });

    await service.synthesize(snapshot());

    const request = complete.mock.calls[0][0];
    const fullPayload = request.systemPrompt + request.prompt;

    expect(fullPayload).not.toMatch(/[\w.-]+@[\w.-]+\.\w+/);
    expect(fullPayload).not.toMatch(/"contactEmail"|"contactPerson"|"fullName"|"contactPhone"/);
  });

  it('throws when the model omits a summary', async () => {
    const complete = vi.fn(async () => ({
      content: JSON.stringify({ risks: [] }),
      provider: 'anthropic' as const,
      model: 'claude-opus-4-6',
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'end_turn',
    }));
    const service = new SecurityOpsAlertSynthesisService({ llmGateway: { complete } });

    await expect(service.synthesize(snapshot())).rejects.toThrow('missing summary');
  });
});
