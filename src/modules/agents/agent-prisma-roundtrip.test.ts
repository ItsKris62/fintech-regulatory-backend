import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma/client';

const safeDatabaseEnvironments = new Set(['development-uat', 'preview']);
const databaseEnvironment = process.env.DATABASE_ENVIRONMENT?.trim().toLowerCase() ?? 'unknown';
const canRunDatabaseTests = safeDatabaseEnvironments.has(databaseEnvironment) && Boolean(process.env.DATABASE_URL);

const describeIfSafeDb = canRunDatabaseTests ? describe : describe.skip;

describeIfSafeDb('AgentRun and AgentReport Prisma parity', () => {
  it('creates and reads AgentRun with cascaded AgentReport shape matching live schema', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const runId = `test-agent-run-${suffix}`;
    const reportId = `test-agent-report-${suffix}`;

    try {
      await prisma.agentRun.create({
        data: {
          id: runId,
          agentType: 'test-agent',
          idempotencyKey: `test-idem-${suffix}`,
          metadata: { test: true },
        },
      });

      await prisma.agentReport.create({
        data: {
          id: reportId,
          agentRunId: runId,
          summary: 'round trip',
          signals: { ok: true },
          recommendedActions: { next: 'none' },
          risks: { level: 'low' },
        },
      });

      const stored = await prisma.agentRun.findUnique({
        where: { id: runId },
        include: { reports: true },
      });

      expect(stored?.status).toBe('RUNNING');
      expect(stored?.inputTokens).toBe(0);
      expect(stored?.outputTokens).toBe(0);
      expect(stored?.costUsd.toString()).toBe('0');
      expect(stored?.iterations).toBe(0);
      expect(stored?.reports).toHaveLength(1);
      expect(stored?.reports[0]).toMatchObject({
        id: reportId,
        agentRunId: runId,
        summary: 'round trip',
        humanApproved: false,
      });
    } finally {
      await prisma.agentRun.deleteMany({ where: { id: runId } });
    }
  }, 30000);
});
