import { describe, expect, it, vi } from 'vitest';
import { CorpusGapService } from './corpus-gap.service';
import type { ClassifiedSignalCore } from './types';

function signal(): ClassifiedSignalCore {
  return {
    sourceItem: {
      id: 'item-1',
      monitorId: 'monitor-1',
      title: 'New Framework Notice',
      url: 'https://regulator.example/notice',
      normalizedUrl: 'https://regulator.example/notice',
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
    sourceUrl: 'https://regulator.example/notice',
    normalizedUrl: 'https://regulator.example/notice',
    contentHash: 'hash-1',
    jurisdiction: 'KE',
    regulatoryBody: 'CBK',
    documentType: 'notice',
    title: 'New Framework Notice',
    summary: 'summary',
    affectedSectors: ['payments'],
    affectedObligations: ['reporting'],
    severityLevel: 'medium',
    effectiveDate: null,
    complianceWindowDays: null,
    referencedFrameworks: ['New Payments Framework'],
    rawContent: 'summary',
    providerTrace: { scanningProvider: 'gemini', analysisProvider: 'anthropic', scanningModel: 'gemini-2.5-flash', analysisModel: 'claude-opus-4-6' },
  };
}

describe('CorpusGapService', () => {
  it('uses only read-only queryVectors and flags missing frameworks', async () => {
    const queryVectors = vi.fn().mockResolvedValue([]);
    const writeProbe = { upsertVectors: vi.fn(), deleteVectors: vi.fn() };
    const service = new CorpusGapService({ queryVectors });

    const result = await service.checkSignal('run-1', signal());

    expect(queryVectors).toHaveBeenCalledWith('New Payments Framework KE CBK', 5, undefined, { jurisdiction: 'KE' });
    expect(writeProbe.upsertVectors).not.toHaveBeenCalled();
    expect(writeProbe.deleteVectors).not.toHaveBeenCalled();
    expect(result.corpusGapDetected).toBe(true);
    expect(result.corpusGapDetails.missingFrameworks).toEqual(['New Payments Framework']);
  });
});