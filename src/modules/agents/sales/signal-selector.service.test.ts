import { describe, expect, it, vi } from 'vitest';
import { SalesSignalSelectorService, sourceFingerprintFor } from './signal-selector.service';

function row() {
  return {
    signalId: 'sig-1',
    sourceUrl: 'https://regulator.test/notice',
    jurisdiction: 'Kenya',
    regulatoryBody: 'CBK',
    documentType: 'notice',
    title: 'CBK notice',
    summary: 'CBK updated reporting expectations.',
    severity: 'high',
    effectiveDate: null,
    complianceWindowDays: null,
    organizationId: 'org-1',
    reason: 'org-1 processes payments affected by this notice.',
    cohort: 'PILOT_COHORT_001',
    organizationName: 'Acme Fintech',
    organizationType: 'startup',
    industry: 'payments',
    cbkLicenseNumber: 'CBK-1234',
    plan: 'STARTUP',
    contactPerson: 'Jane Doe',
    contactEmail: 'jane@acme.test',
    contactPhone: '+254700000000',
    pilotStatus: 'ACTIVE',
    pilotStartsAt: new Date('2026-06-01T00:00:00.000Z'),
    pilotExpiresAt: new Date('2026-07-15T00:00:00.000Z'),
  };
}

describe('SalesSignalSelectorService', () => {
  it('excludes signal+organization pairs already drafted', async () => {
    const queryRaw = vi.fn().mockResolvedValue([row()]);
    const service = new SalesSignalSelectorService({ prisma: { $queryRaw: queryRaw } });

    const result = await service.selectProspects({ limit: 5 });

    expect(result).toEqual([
      expect.objectContaining({
        signalId: 'sig-1',
        organizationId: 'org-1',
        organizationName: 'Acme Fintech',
        reason: 'org-1 processes payments affected by this notice.',
        contactEmail: 'jane@acme.test',
        pilotExpiresAt: '2026-07-15T00:00:00.000Z',
      }),
    ]);
    const query = queryRaw.mock.calls[0][0] as { strings?: readonly string[] };
    const sql = query.strings?.join('') ?? '';
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('"SalesOutreachDraft"');
    expect(sql).toContain('jsonb_array_elements');
    expect(sql).toContain('"pilotFintechsAffected"');
    expect(sql).toContain('"sourceFingerprint" = rs."id" || \'|\' || (impact->>\'organizationId\')');
  });

  it('builds a stable signalId|organizationId dedup fingerprint', () => {
    expect(sourceFingerprintFor('sig-1', 'org-1')).toBe('sig-1|org-1');
  });
});
