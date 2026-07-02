import { describe, expect, it, vi } from 'vitest';
import { ImpactMatcherService } from './impact-matcher.service';
import type { ClassifiedSignalCore } from './types';

function signal(): ClassifiedSignalCore {
  return {
    sourceItem: {
      id: 'item-1',
      monitorId: 'monitor-1',
      title: 'CBK PSP Reporting Notice',
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
    },
    sourceUrl: 'https://www.centralbank.go.ke/notice',
    normalizedUrl: 'https://www.centralbank.go.ke/notice',
    contentHash: 'hash-1',
    jurisdiction: 'KE',
    regulatoryBody: 'CBK',
    documentType: 'notice',
    title: 'CBK PSP Reporting Notice',
    summary: 'summary',
    affectedSectors: ['payments'],
    affectedObligations: ['reporting'],
    severityLevel: 'high',
    effectiveDate: null,
    complianceWindowDays: 30,
    referencedFrameworks: ['CBK PSP Regulations'],
    rawContent: 'summary',
    providerTrace: { scanningProvider: 'gemini', analysisProvider: 'anthropic', scanningModel: 'gemini-2.5-flash', analysisModel: 'claude-opus-4-6' },
  };
}

describe('ImpactMatcherService', () => {
  it('matches active pilot fintechs by sector, jurisdiction, and license fields', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'user-1',
        email: 'founder@example.com',
        pilotCohort: 'PILOT_COHORT_001',
        organization: {
          id: 'org-1',
          name: 'Acme Payments',
          organizationType: 'startup',
          industry: 'Fintech payments',
          cbkLicenseNumber: 'CBK-PSP-1',
          website: 'https://acme.example',
        },
      },
    ]);
    const service = new ImpactMatcherService({
      prisma: { user: { findMany } },
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });

    const impacts = await service.matchSignal('run-1', signal());

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ pilotCohort: 'PILOT_COHORT_001' }) }));
    expect(impacts).toHaveLength(1);
    expect(impacts[0]).toMatchObject({ organizationId: 'org-1', organizationName: 'Acme Payments' });
    expect(impacts[0].matchedFields).toContain('license:cbk');
  });
});