import { describe, expect, it, vi } from 'vitest';
import { ChiefOfStaffSourceReportsService } from './source-reports.service';
import { SOURCE_AGENT_TYPES } from './types';

describe('ChiefOfStaffSourceReportsService', () => {
  it('queries the latest AgentReport for each of the five known source agent types independently', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const service = new ChiefOfStaffSourceReportsService({ prisma: { agentReport: { findFirst } } as never });

    await service.fetchAllSourceReports();

    expect(findFirst).toHaveBeenCalledTimes(5);
    const queriedAgentTypes = findFirst.mock.calls.map((call) => (call[0] as { where: { run: { agentType: string } } }).where.run.agentType);
    expect(queriedAgentTypes.sort()).toEqual([...SOURCE_AGENT_TYPES].sort());
  });

  it('returns a null-shaped extract for a source agent type with no report yet, without throwing', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const service = new ChiefOfStaffSourceReportsService({ prisma: { agentReport: { findFirst } } as never });

    const extracts = await service.fetchAllSourceReports();

    expect(extracts).toHaveLength(5);
    for (const extract of extracts) {
      expect(extract).toMatchObject({ reportId: null, summary: null, riskNotes: [], actionNotes: [], itemCounts: {} });
    }
  });

  it('extracts plain string arrays (risks.notes, recommendedActions.opportunities) uniformly regardless of field name', async () => {
    const findFirst = vi.fn()
      .mockResolvedValueOnce({ id: 'report-regintel', summary: 'Reg intel summary', risks: { critical: ['a'], high: ['b'] }, recommendedActions: { marketing: [{ x: 1 }], sales: [{ y: 2 }, { z: 3 }] }, createdAt: new Date('2026-07-01') })
      .mockResolvedValueOnce({ id: 'report-marketing', summary: 'Marketing summary', risks: { notes: ['review needed'] }, recommendedActions: { humanReviewQueue: [{ draftId: 'd1' }] }, createdAt: new Date('2026-07-02') })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const service = new ChiefOfStaffSourceReportsService({ prisma: { agentReport: { findFirst } } as never });

    const [regIntel, marketing] = await service.fetchAllSourceReports();

    expect(regIntel).toMatchObject({
      agentType: 'regulatory-intelligence',
      reportId: 'report-regintel',
      summary: 'Reg intel summary',
      riskNotes: ['a', 'b'],
      itemCounts: { marketing: 1, sales: 2 },
    });
    expect(marketing).toMatchObject({
      agentType: 'marketing',
      reportId: 'report-marketing',
      summary: 'Marketing summary',
      riskNotes: ['review needed'],
      itemCounts: { humanReviewQueue: 1 },
    });
  });
});
