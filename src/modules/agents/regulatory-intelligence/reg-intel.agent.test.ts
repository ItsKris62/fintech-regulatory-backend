import { describe, expect, it, vi } from 'vitest';
import { AgentBudgetHalt, type AgentRunService } from '@/modules/agents/agent-run.service';
import { RegulatoryIntelligenceAgent, type RegIntelDependencies } from './reg-intel.agent';
import type { ClassifiedSignalCore, RawRegulatorySourceItem } from './types';

function sourceItem(): RawRegulatorySourceItem {
  return {
    id: 'item-1',
    monitorId: 'monitor-1',
    title: 'CBK Notice',
    url: 'https://www.centralbank.go.ke/notice',
    normalizedUrl: 'https://www.centralbank.go.ke/notice',
    summary: 'summary',
    jurisdiction: 'KE',
    authorityType: 'CENTRAL_BANK',
    sourceType: 'OFFICIAL',
    publicationDate: null,
    discoveredAt: new Date('2026-07-02T00:00:00.000Z'),
    contentHash: 'hash-1',
    rawContentHash: null,
    monitorName: 'Central Bank of Kenya',
  };
}

function classifiedSignal(): ClassifiedSignalCore {
  const item = sourceItem();
  return {
    sourceItem: item,
    sourceUrl: item.url,
    normalizedUrl: item.normalizedUrl,
    contentHash: item.contentHash,
    jurisdiction: 'KE',
    regulatoryBody: 'CBK',
    documentType: 'notice',
    title: 'CBK Notice',
    summary: 'CBK changed PSP reporting expectations.',
    affectedSectors: ['payments'],
    affectedObligations: ['reporting'],
    severityLevel: 'high',
    effectiveDate: null,
    complianceWindowDays: 30,
    referencedFrameworks: ['CBK PSP Regulations'],
    rawContent: 'CBK Notice summary',
    providerTrace: { scanningProvider: 'gemini', analysisProvider: 'anthropic', scanningModel: 'gemini-2.5-flash', analysisModel: 'claude-opus-4-6' },
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

describe('RegulatoryIntelligenceAgent', () => {
  it('respects the kill switch before source or provider work', async () => {
    const sourceMonitor = { scanSources: vi.fn() };
    const service = agentRunService({ beginRun: vi.fn().mockResolvedValue({ started: false, reason: 'agents_disabled' }) });
    const agent = new RegulatoryIntelligenceAgent({
      agentRuns: service,
      sourceMonitor: sourceMonitor as unknown as RegIntelDependencies['sourceMonitor'],
    });

    const result = await agent.runScan({ idempotencyKey: 'idem-disabled' });

    expect(result.status).toBe('SKIPPED_DISABLED');
    expect(sourceMonitor.scanSources).not.toHaveBeenCalled();
  });

  it('creates deduplicated RegulatorySignal rows and DRAFT AgentReport output', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ id: 'sig-1' }]);
    const createReport = vi.fn().mockResolvedValue({ id: 'report-1' });
    const service = agentRunService({ createReport });
    const agent = new RegulatoryIntelligenceAgent({
      prisma: {
        $queryRaw: queryRaw,
        regulatorySignal: { findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
        agentReport: { findFirst: vi.fn() },
        agentRun: { update: vi.fn() },
      },
      sourceMonitor: { scanSources: vi.fn().mockResolvedValue({ items: [sourceItem()], unverifiedSourceGaps: [], monitorSummaries: [] }) } as unknown as RegIntelDependencies['sourceMonitor'],
      classifier: {
        scanItems: vi.fn().mockResolvedValue({ candidates: [], usage: null }),
        deepAnalyze: vi.fn().mockResolvedValue({ signals: [classifiedSignal()], usage: [] }),
      } as unknown as RegIntelDependencies['classifier'],
      corpusGap: { checkSignal: vi.fn().mockResolvedValue({ corpusGapDetected: false, corpusGapDetails: { missingFrameworks: [], checkedQueries: [], matchedFrameworks: ['CBK PSP Regulations'] } }) } as unknown as RegIntelDependencies['corpusGap'],
      impactMatcher: { matchSignal: vi.fn().mockResolvedValue([]) } as unknown as RegIntelDependencies['impactMatcher'],
      agentRuns: service,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });

    const result = await agent.runScan({ idempotencyKey: 'idem-complete' });

    expect(result).toMatchObject({ status: 'COMPLETED', reportId: 'report-1', signalsCreated: 1 });
    const firstQueryArg = queryRaw.mock.calls[0][0] as TemplateStringsArray;
    expect(firstQueryArg.join('')).toContain('ON CONFLICT ("sourceUrl", "contentHash") DO NOTHING');
    expect(createReport).toHaveBeenCalledWith(expect.objectContaining({ humanApproved: false }));
    expect(service.completeRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1' }));
  });

  it('persists partial results and marks run HALTED_BUDGET when budget halts after a signal insert', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ id: 'sig-1' }]);
    const update = vi.fn().mockResolvedValue({ id: 'run-1', status: 'HALTED_BUDGET' });
    const advanceRun = vi.fn()
      .mockResolvedValueOnce({ id: 'run-1', status: 'RUNNING' })
      .mockRejectedValueOnce(new AgentBudgetHalt('daily_cost_exceeded'));
    const createReport = vi.fn().mockResolvedValue({ id: 'partial-report' });
    const service = agentRunService({ advanceRun, createReport });
    const agent = new RegulatoryIntelligenceAgent({
      prisma: {
        $queryRaw: queryRaw,
        regulatorySignal: { findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
        agentReport: { findFirst: vi.fn() },
        agentRun: { update },
      },
      sourceMonitor: { scanSources: vi.fn().mockResolvedValue({ items: [sourceItem()], unverifiedSourceGaps: [], monitorSummaries: [] }) } as unknown as RegIntelDependencies['sourceMonitor'],
      classifier: {
        scanItems: vi.fn().mockResolvedValue({ candidates: [], usage: null }),
        deepAnalyze: vi.fn().mockResolvedValue({ signals: [classifiedSignal()], usage: [] }),
      } as unknown as RegIntelDependencies['classifier'],
      corpusGap: { checkSignal: vi.fn().mockResolvedValue({ corpusGapDetected: false, corpusGapDetails: { missingFrameworks: [], checkedQueries: [], matchedFrameworks: ['CBK PSP Regulations'] } }) } as unknown as RegIntelDependencies['corpusGap'],
      impactMatcher: { matchSignal: vi.fn().mockResolvedValue([]) } as unknown as RegIntelDependencies['impactMatcher'],
      agentRuns: service,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });

    const result = await agent.runScan({ idempotencyKey: 'idem-budget' });

    expect(queryRaw).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 'HALTED_BUDGET', reportId: 'partial-report', signalsCreated: 1 });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'HALTED_BUDGET' }) }));
    expect(createReport).toHaveBeenCalledWith(expect.objectContaining({ humanApproved: false }));
  });
});