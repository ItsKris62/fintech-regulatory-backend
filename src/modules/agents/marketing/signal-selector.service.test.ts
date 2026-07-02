import { describe, expect, it, vi } from 'vitest';
import { MarketingSignalSelectorService, sourceFingerprintFor } from './signal-selector.service';

function row() {
  return {
    id: 'sig-1',
    sourceUrl: 'https://regulator.test/notice',
    jurisdiction: 'Kenya',
    regulatoryBody: 'CBK',
    documentType: 'notice',
    title: 'CBK notice',
    summary: 'CBK updated reporting expectations.',
    severity: 'high',
    affectedSectors: ['payments'],
    affectedObligations: ['reporting'],
    effectiveDate: null,
    complianceWindowDays: null,
    status: 'NEW',
    createdAt: new Date('2026-07-02T00:00:00.000Z'),
  };
}

describe('MarketingSignalSelectorService', () => {
  it('excludes signals already drafted for the same content type', async () => {
    const queryRaw = vi.fn().mockResolvedValue([row()]);
    const service = new MarketingSignalSelectorService({ prisma: { $queryRaw: queryRaw } });

    const result = await service.selectSignals({ contentType: 'newsletter_item', limit: 5 });

    expect(result).toEqual([expect.objectContaining({ id: 'sig-1', affectedSectors: ['payments'], affectedObligations: ['reporting'] })]);
    const query = queryRaw.mock.calls[0][0] as { strings?: readonly string[] };
    expect(query.strings?.join('')).toContain('NOT EXISTS');
    expect(query.strings?.join('')).toContain('"MarketingDraft"');
    expect(query.strings?.join('')).toContain('"sourceFingerprint" = rs."id"');
  });

  it('uses sorted signal IDs for stable dedup fingerprints', () => {
    expect(sourceFingerprintFor(['sig-b', 'sig-a'])).toBe('sig-a|sig-b');
  });
});