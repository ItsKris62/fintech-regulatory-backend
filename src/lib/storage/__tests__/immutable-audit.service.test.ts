import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildAuditStorageKey,
  writeImmutableAuditRecord,
} from '../immutable-audit.service';
import { r2PrivateClient, r2AuditBucket } from '../r2-private-client';

describe('immutable-audit.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds key conforming to audit/{yyyy}/{mm}/{dd}/{eventId}.jsonl', () => {
    const fixedDate = new Date('2026-09-23T14:30:00Z');
    const key = buildAuditStorageKey(fixedDate, 'evt-12345');
    expect(key).toBe('audit/2026/09/23/evt-12345.jsonl');
  });

  it('generates random nanoid if eventId is omitted', () => {
    const fixedDate = new Date('2026-09-23T14:30:00Z');
    const key = buildAuditStorageKey(fixedDate);
    expect(key).toMatch(/^audit\/2026\/09\/23\/[a-z0-9]{16}\.jsonl$/);
  });

  it('writes jsonl records to the immutable audit bucket', async () => {
    const sendSpy = vi.spyOn(r2PrivateClient, 'send').mockResolvedValue({} as never);

    const testRecord = {
      action: 'USER_LOGIN',
      userId: 'usr-1',
      organizationId: 'org-1',
      details: { ip: '127.0.0.1' },
    };

    const fixedDate = new Date('2026-09-23T12:00:00Z');
    const res = await writeImmutableAuditRecord(testRecord, {
      eventId: 'evt-test-1',
      date: fixedDate,
    });

    expect(res.bucket).toBe(r2AuditBucket);
    expect(res.key).toBe('audit/2026/09/23/evt-test-1.jsonl');
    expect(sendSpy).toHaveBeenCalledTimes(1);

    const callArg = sendSpy.mock.calls[0][0] as any;
    expect(callArg.input.Bucket).toBe('sheria-bot-audit-immutable');
    expect(callArg.input.Key).toBe('audit/2026/09/23/evt-test-1.jsonl');
    expect(callArg.input.ContentType).toBe('application/x-ndjson');
    expect(callArg.input.Metadata).toEqual({
      'immutable-audit': 'true',
      'record-count': '1',
    });
  });
});
