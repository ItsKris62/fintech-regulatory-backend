import { describe, expect, it, vi } from 'vitest';
import { AutomationPilotVendorService } from './pilot-vendor.service';

const NOW = new Date('2026-07-22T12:00:00.000Z');

describe('AutomationPilotVendorService.getPilotCohortStatus', () => {
  it('groups pilot users by org, using the most-recent user\'s status, and computes real days-since-last-query', async () => {
    const user = {
      findMany: vi.fn().mockResolvedValue([
        { organizationId: 'org_1', pilotAccessStatus: 'ACTIVE', createdAt: new Date('2026-07-20T00:00:00.000Z') },
      ]),
    };
    const complianceQuery = {
      findFirst: vi.fn().mockResolvedValue({ createdAt: new Date('2026-07-15T00:00:00.000Z') }),
    };
    const service = new AutomationPilotVendorService({ prisma: { user, complianceQuery } as never, now: () => NOW });

    const result = await service.getPilotCohortStatus({ cohort: 'PILOT_COHORT_001', jurisdictions: '' });

    expect(result).toEqual({ orgs: [{ orgId: 'org_1', status: 'ACTIVE', daysSinceLastQuery: 7 }] });
  });

  it('falls back to days-since-pilot-signal (not 0) when the org has never run a ComplianceQuery', async () => {
    const user = {
      findMany: vi.fn().mockResolvedValue([
        { organizationId: 'org_1', pilotAccessStatus: 'ACTIVE', createdAt: new Date('2026-07-10T00:00:00.000Z') },
      ]),
    };
    const complianceQuery = { findFirst: vi.fn().mockResolvedValue(null) };
    const service = new AutomationPilotVendorService({ prisma: { user, complianceQuery } as never, now: () => NOW });

    const result = await service.getPilotCohortStatus({ cohort: 'PILOT_COHORT_001', jurisdictions: '' });
    expect(result.orgs[0].daysSinceLastQuery).toBe(12);
  });

  it('short-circuits to an empty org list when the jurisdiction filter excludes Kenya', async () => {
    const user = { findMany: vi.fn() };
    const complianceQuery = { findFirst: vi.fn() };
    const service = new AutomationPilotVendorService({ prisma: { user, complianceQuery } as never, now: () => NOW });

    const result = await service.getPilotCohortStatus({ cohort: 'PILOT_COHORT_001', jurisdictions: 'Nigeria' });
    expect(result).toEqual({ orgs: [] });
    expect(user.findMany).not.toHaveBeenCalled();
  });
});

describe('AutomationPilotVendorService.getDpaVendorStatus', () => {
  it('returns an honestly-empty vendor list with dataAvailable:false - no vendor-tracking model exists', async () => {
    const service = new AutomationPilotVendorService({ now: () => NOW });
    const result = await service.getDpaVendorStatus();
    expect(result).toEqual({ vendors: [], dataAvailable: false });
  });
});
