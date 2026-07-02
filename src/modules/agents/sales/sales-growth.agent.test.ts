import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AgentBudgetHalt, type AgentRunService } from '@/modules/agents/agent-run.service';
import { SalesGrowthAgent, type SalesGrowthAgentDependencies } from './sales-growth.agent';
import type { EngagementContext, GroundedSalesProspect, OutreachDraftContent, PersistedSalesOutreachDraft } from './types';

function prospect(organizationId = 'org-1'): GroundedSalesProspect {
  return {
    signalId: 'sig-1',
    organizationId,
    sourceUrl: 'https://centralbank.go.ke/notice',
    jurisdiction: 'Kenya',
    regulatoryBody: 'CBK',
    documentType: 'notice',
    title: 'CBK notice',
    summary: 'CBK updated reporting expectations.',
    severity: 'high',
    effectiveDate: null,
    complianceWindowDays: null,
    reason: 'Acme Fintech processes payments affected by this notice.',
    cohort: 'PILOT_COHORT_001',
    organizationName: 'Acme Fintech',
    organizationType: 'startup',
    industry: 'payments',
    cbkLicenseNumber: 'CBK-1234',
    plan: 'STARTUP',
    contactPerson: 'Jane Doe',
    contactEmail: 'jane@acme.test',
    contactPhone: null,
    pilotStatus: 'ACTIVE',
    pilotStartsAt: '2026-06-01T00:00:00.000Z',
    pilotExpiresAt: '2026-07-15T00:00:00.000Z',
  };
}

function engagement(): EngagementContext {
  return { available: false, reason: 'posthog_not_configured' };
}

function draft(): OutreachDraftContent {
  return {
    subject: 'CBK reporting update',
    body: 'Hi Jane, CBK updated reporting expectations that affect Acme Fintech...',
    priority: 'high',
    metadata: { signalId: 'sig-1', organizationId: 'org-1' },
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.02, provider: 'anthropic', model: 'claude-opus-4-6' },
  };
}

function persisted(id: string): PersistedSalesOutreachDraft {
  return {
    id,
    sourceSignalId: 'sig-1',
    organizationId: 'org-1',
    triggerReason: 'Acme Fintech processes payments affected by this notice.',
    engagementContext: { available: false, reason: 'posthog_not_configured' },
    subject: 'CBK reporting update',
    body: 'Hi Jane, CBK updated reporting expectations that affect Acme Fintech...',
    priority: 'high',
    status: 'DRAFT',
    agentRunId: 'run-1',
    generatedAt: new Date('2026-07-02T00:00:00.000Z'),
    reviewedAt: null,
    reviewedBy: null,
    editedBody: null,
    sourceFingerprint: 'sig-1|org-1',
    metadata: null,
  };
}

function agentRunService(overrides: Partial<Record<keyof AgentRunService, unknown>> = {}): AgentRunService {
  const service = {
    beginRun: vi.fn().mockResolvedValue({ started: true, duplicate: false, run: { id: 'run-1', status: 'RUNNING' } }),
    advanceRun: vi.fn().mockResolvedValue({ id: 'run-1', status: 'RUNNING' }),
    completeRun: vi.fn().mockResolvedValue({ id: 'run-1', status: 'COMPLETED' }),
    failRun: vi.fn().mockResolvedValue({ id: 'run-1', status: 'FAILED' }),
    createReport: vi.fn().mockResolvedValue({ id: 'report-1' }),
    getRun: vi.fn(),
    ...overrides,
  };
  return service as unknown as AgentRunService;
}

describe('SalesGrowthAgent', () => {
  it('respects the kill switch before selecting, looking up engagement, or drafting', async () => {
    const selector = { selectProspects: vi.fn() };
    const engagementLookup = { lookup: vi.fn() };
    const runs = agentRunService({ beginRun: vi.fn().mockResolvedValue({ started: false, reason: 'agents_disabled' }) });
    const agent = new SalesGrowthAgent({
      selector: selector as unknown as SalesGrowthAgentDependencies['selector'],
      engagementLookup: engagementLookup as unknown as SalesGrowthAgentDependencies['engagementLookup'],
      agentRuns: runs,
    });

    const result = await agent.runDrafting({ idempotencyKey: 'sales-disabled' });

    expect(result.status).toBe('SKIPPED_DISABLED');
    expect(selector.selectProspects).not.toHaveBeenCalled();
    expect(engagementLookup.lookup).not.toHaveBeenCalled();
  });

  it('creates outreach drafts, looks up engagement per prospect, and captures usage', async () => {
    const create = vi.fn().mockResolvedValueOnce(persisted('draft-1'));
    const runs = agentRunService();
    const agent = new SalesGrowthAgent({
      prisma: {
        salesOutreachDraft: { create, findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
      },
      selector: {
        selectProspects: vi.fn().mockResolvedValueOnce([prospect()]),
      } as unknown as SalesGrowthAgentDependencies['selector'],
      engagementLookup: {
        lookup: vi.fn().mockResolvedValue(engagement()),
      } as unknown as SalesGrowthAgentDependencies['engagementLookup'],
      drafter: {
        draftOutreach: vi.fn().mockResolvedValue(draft()),
      } as unknown as SalesGrowthAgentDependencies['drafter'],
      agentRuns: runs,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });

    const result = await agent.runDrafting({ idempotencyKey: 'sales-complete' });

    expect(result).toMatchObject({ status: 'COMPLETED', draftsCreated: 1, reportId: 'report-1' });
    expect(create.mock.calls[0][0].data).toMatchObject({
      sourceSignalId: 'sig-1',
      organizationId: 'org-1',
      sourceFingerprint: 'sig-1|org-1',
      triggerReason: 'Acme Fintech processes payments affected by this notice.',
    });
    expect(runs.advanceRun).toHaveBeenCalledTimes(1);
    expect(runs.completeRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1' }));
  });

  it('returns HALTED_BUDGET when budget guards halt after usage capture', async () => {
    const runs = agentRunService({ advanceRun: vi.fn().mockRejectedValue(new AgentBudgetHalt('daily_cost_exceeded')) });
    const agent = new SalesGrowthAgent({
      prisma: {
        salesOutreachDraft: { create: vi.fn().mockResolvedValue(persisted('draft-1')), findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
      },
      selector: {
        selectProspects: vi.fn().mockResolvedValueOnce([prospect()]),
      } as unknown as SalesGrowthAgentDependencies['selector'],
      engagementLookup: {
        lookup: vi.fn().mockResolvedValue(engagement()),
      } as unknown as SalesGrowthAgentDependencies['engagementLookup'],
      drafter: {
        draftOutreach: vi.fn().mockResolvedValue(draft()),
      } as unknown as SalesGrowthAgentDependencies['drafter'],
      agentRuns: runs,
    });

    const result = await agent.runDrafting({ idempotencyKey: 'sales-budget' });

    expect(result).toMatchObject({ status: 'HALTED_BUDGET', reportId: 'report-1', draftsCreated: 1 });
    expect(runs.createReport).toHaveBeenCalledWith(expect.objectContaining({ humanApproved: false }));
  });

  it('skips duplicate draft inserts caused by the unique source fingerprint', async () => {
    const uniqueError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const runs = agentRunService();
    const agent = new SalesGrowthAgent({
      prisma: {
        salesOutreachDraft: { create: vi.fn().mockRejectedValue(uniqueError), findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
      },
      selector: {
        selectProspects: vi.fn().mockResolvedValueOnce([prospect()]),
      } as unknown as SalesGrowthAgentDependencies['selector'],
      engagementLookup: {
        lookup: vi.fn().mockResolvedValue(engagement()),
      } as unknown as SalesGrowthAgentDependencies['engagementLookup'],
      drafter: {
        draftOutreach: vi.fn().mockResolvedValue(draft()),
      } as unknown as SalesGrowthAgentDependencies['drafter'],
      agentRuns: runs,
    });

    const result = await agent.runDrafting({ idempotencyKey: 'sales-dedup' });

    expect(result).toMatchObject({ status: 'COMPLETED', draftsCreated: 0 });
  });
});
