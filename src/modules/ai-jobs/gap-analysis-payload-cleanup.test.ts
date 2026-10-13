import { describe, expect, it, vi } from 'vitest';
import {
  cleanupLegacyGapAnalysisPayloads,
  legacyDocumentFields,
  scrubLegacyDocumentFields,
} from './gap-analysis-payload-cleanup';

function mockClient(pages: unknown[][]) {
  const findMany = vi.fn();
  for (const page of pages) findMany.mockResolvedValueOnce(page);
  const update = vi.fn().mockResolvedValue({});
  const auditCreate = vi.fn().mockResolvedValue({});
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) => callback({ aiJob: { update } }));
  return {
    client: {
      aiJob: { findMany, update },
      auditLog: { create: auditCreate },
      $transaction: transaction,
    } as any,
    findMany,
    update,
    auditCreate,
    transaction,
  };
}

describe('Batch 4.1 legacy Gap Analysis AiJob payload cleanup', () => {
  it('detects legacy terminal payloads in dry-run and changes zero rows', async () => {
    const canary = 'SHERIABOT_PRIVATE_POLICY_CANARY_4A91F';
    const mocks = mockClient([
      [
        { id: '1', status: 'COMPLETED', payload: { fileContent: canary, analysisId: 'ga-1' } },
        { id: '2', status: 'FAILED', payload: { base64: canary, rawText: canary } },
        { id: '3', status: 'CANCELLED', payload: { analysisId: 'ga-3' } },
      ],
      [],
    ]);

    const summary = await cleanupLegacyGapAnalysisPayloads(mocks.client);

    expect(summary).toMatchObject({
      dryRun: true,
      rowsInspected: 3,
      legacyPayloadsDetected: 2,
      terminalAndSafeToScrub: 2,
      activeOrRetryable: 0,
      alreadyClean: 1,
      rowsScrubbed: 0,
      documentsPrinted: 0,
    });
    expect(JSON.stringify(summary)).not.toContain(canary);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('scrubs all four legacy document fields from terminal rows and records counts only', async () => {
    const mocks = mockClient([
      [{
        id: 'terminal-1',
        status: 'DEAD_LETTERED',
        payload: {
          analysisId: 'ga-1',
          fileContent: 'secret-1',
          base64: 'secret-2',
          fileBuffer: { type: 'Buffer', data: [1, 2, 3] },
          rawText: 'secret-3',
        },
      }],
      [],
    ]);

    const summary = await cleanupLegacyGapAnalysisPayloads(mocks.client, {
      execute: true,
      now: () => new Date('2026-10-08T00:00:00.000Z'),
    });

    expect(summary.rowsScrubbed).toBe(1);
    const written = mocks.update.mock.calls[0][0].data.payload;
    expect(written).toEqual({
      analysisId: 'ga-1',
      payloadScrubbedAt: '2026-10-08T00:00:00.000Z',
    });
    expect(JSON.stringify(mocks.auditCreate.mock.calls[0][0])).not.toContain('secret');
  });

  it.each(['QUEUED', 'RUNNING', 'RETRYING'])('retains active legacy payload in %s', async (status) => {
    const mocks = mockClient([
      [{ id: status, status, payload: { fileContent: 'required-by-legacy-worker' } }],
      [],
    ]);

    const summary = await cleanupLegacyGapAnalysisPayloads(mocks.client, { execute: true });

    expect(summary.activeOrRetryable).toBe(1);
    expect(summary.rowsScrubbed).toBe(0);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('is idempotent after fields are scrubbed', () => {
    const first = scrubLegacyDocumentFields(
      { analysisId: 'ga-1', fileContent: 'secret', rawText: 'secret' },
      '2026-10-08T00:00:00.000Z',
    );
    expect(legacyDocumentFields(first as any)).toEqual([]);
    expect(scrubLegacyDocumentFields(first as any, '2026-10-09T00:00:00.000Z')).toEqual({
      analysisId: 'ga-1',
      payloadScrubbedAt: '2026-10-08T00:00:00.000Z',
    });
  });
});
