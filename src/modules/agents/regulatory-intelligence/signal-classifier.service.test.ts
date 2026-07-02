import { describe, expect, it, vi } from 'vitest';
import type { LLMCompletionRequest, LLMCompletionResult } from '@/lib/ai/gateway/types';
import { SignalClassifierService } from './signal-classifier.service';
import type { RawRegulatorySourceItem } from './types';

function item(): RawRegulatorySourceItem {
  return {
    id: 'item-1',
    monitorId: 'monitor-1',
    title: 'CBK Digital Credit Notice',
    url: 'https://www.centralbank.go.ke/notice',
    normalizedUrl: 'https://www.centralbank.go.ke/notice',
    summary: '<script>x</script><p>New digital credit reporting obligations.</p>',
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

function result(content: string, provider: 'gemini' | 'anthropic', model: string): LLMCompletionResult {
  return {
    content,
    provider,
    model,
    usage: { inputTokens: 100, outputTokens: 50 },
    stopReason: 'stop',
  };
}

describe('SignalClassifierService', () => {
  it('routes scan to Gemini and deep analysis to Anthropic without fallback', async () => {
    const requests: LLMCompletionRequest[] = [];
    const complete = vi.fn().mockImplementation((req: LLMCompletionRequest) => {
      requests.push(req);
      if (req.provider === 'gemini') {
        return Promise.resolve(result(JSON.stringify({ items: [{ sourceItemId: 'item-1', isRegulatory: true, jurisdiction: 'KE', regulatoryBody: 'CBK', documentType: 'notice', confidence: 0.98, reason: 'Official CBK notice' }] }), 'gemini', 'gemini-2.5-flash'));
      }
      return Promise.resolve(result(JSON.stringify({ title: 'CBK Digital Credit Notice', summary: 'CBK introduced reporting obligations.', affectedSectors: ['digital-lending'], affectedObligations: ['reporting'], severityLevel: 'high', effectiveDate: null, complianceWindowDays: 30, referencedFrameworks: ['CBK Digital Credit Regulations'] }), 'anthropic', 'claude-opus-4-6'));
    });

    const service = new SignalClassifierService({ llmGateway: { complete } });
    const scan = await service.scanItems('run-1', [item()]);
    const analysis = await service.deepAnalyze('run-1', scan.candidates, scan.usage);

    expect(requests[0]).toMatchObject({ provider: 'gemini', allowFallback: false });
    expect(requests[1]).toMatchObject({ provider: 'anthropic', allowFallback: false });
    expect(analysis.signals[0].rawContent).not.toContain('<script>');
    expect(analysis.signals[0].providerTrace).toMatchObject({ scanningProvider: 'gemini', analysisProvider: 'anthropic' });
  });
});