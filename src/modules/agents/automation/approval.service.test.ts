import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { AutomationApprovalService, type CreateApprovalInput } from './approval.service';
import { signApprovalCallback } from './approval-callback-signature';

const NOW = new Date('2026-07-22T12:00:00.000Z');
const HMAC_SECRET = 'test-hmac-secret-not-real';

function baseCreateInput(overrides: Partial<CreateApprovalInput> = {}): CreateApprovalInput {
  return {
    department: 'marketing',
    workflow: 'weekly-newsletter',
    kind: 'newsletter',
    summary: 'Weekly compliance digest ready for review.',
    callbackUrl: 'https://agents.sheriabot.com/webhook/approval-callback',
    metadata: { draftId: 'draft_1' },
    idempotencyKey: 'idem_default',
    ...overrides,
  };
}

interface FakeApprovalRow {
  id: string;
  status: string;
  callbackUrl: string;
  callbackError: string | null;
  callbackDeliveredAt: Date | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  idempotencyKey: string | null;
  expiresAt: Date | null;
}

/** In-memory fake standing in for prisma.automationApproval, keyed by id. */
function createFakePrisma() {
  const rows = new Map<string, FakeApprovalRow>();
  let counter = 0;

  function matchesWhere(row: FakeApprovalRow, where: Record<string, unknown>): boolean {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.expiresAt !== undefined) {
      const cond = where.expiresAt as { lt?: Date };
      if (cond.lt !== undefined && !(row.expiresAt && row.expiresAt < cond.lt)) return false;
    }
    return true;
  }

  return {
    rows,
    automationApproval: {
      create: vi.fn().mockImplementation(({ data }: { data: { callbackUrl: string; idempotencyKey?: string | null; expiresAt?: Date | null } }) => {
        if (data.idempotencyKey && [...rows.values()].some((r) => r.idempotencyKey === data.idempotencyKey)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`idempotencyKey`)', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        const id = `appr_${++counter}`;
        rows.set(id, {
          id,
          status: 'pending',
          callbackUrl: data.callbackUrl,
          callbackError: null,
          callbackDeliveredAt: null,
          decidedBy: null,
          decidedAt: null,
          idempotencyKey: data.idempotencyKey ?? null,
          expiresAt: data.expiresAt ?? null,
        });
        return Promise.resolve({ id });
      }),
      findUnique: vi.fn().mockImplementation(({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
        if (where.id !== undefined) return Promise.resolve(rows.get(where.id) ?? null);
        return Promise.resolve([...rows.values()].find((r) => r.idempotencyKey === where.idempotencyKey) ?? null);
      }),
      findUniqueOrThrow: vi.fn().mockImplementation(({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
        const row = where.id !== undefined ? rows.get(where.id) : [...rows.values()].find((r) => r.idempotencyKey === where.idempotencyKey);
        if (!row) throw new Error('not found');
        return Promise.resolve(row);
      }),
      updateMany: vi.fn().mockImplementation(({ where, data }: { where: Record<string, unknown>; data: Partial<FakeApprovalRow> }) => {
        let count = 0;
        for (const row of rows.values()) {
          if (matchesWhere(row, where)) {
            Object.assign(row, data);
            count++;
          }
        }
        return Promise.resolve({ count });
      }),
      update: vi.fn().mockImplementation(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.get(where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return Promise.resolve(row);
      }),
    },
  };
}

describe('AutomationApprovalService.listApprovals', () => {
  function approvalRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'appr_1',
      department: 'marketing',
      workflow: 'weekly-newsletter',
      kind: 'newsletter',
      summary: 'Weekly digest ready.',
      metadata: { draftId: 'draft_1' },
      status: 'pending',
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
      decidedBy: null,
      decidedAt: null,
      callbackError: null,
      callbackDeliveredAt: null,
      ...overrides,
    };
  }

  it('serializes dates to ISO strings and passes through metadata/status/decision fields', async () => {
    const findMany = vi.fn().mockResolvedValue([
      approvalRow({ status: 'approved', decidedBy: 'user_1', decidedAt: new Date('2026-07-21T00:00:00.000Z') }),
    ]);
    const count = vi.fn().mockResolvedValue(1);
    const service = new AutomationApprovalService({ prisma: { automationApproval: { findMany, count } } as never, now: () => NOW, hmacSecret: HMAC_SECRET });

    const result = await service.listApprovals({ page: 1, limit: 20 });

    expect(result).toEqual({
      rows: [{
        id: 'appr_1',
        department: 'marketing',
        workflow: 'weekly-newsletter',
        kind: 'newsletter',
        summary: 'Weekly digest ready.',
        metadata: { draftId: 'draft_1' },
        status: 'approved',
        createdAt: '2026-07-20T00:00:00.000Z',
        decidedBy: 'user_1',
        decidedAt: '2026-07-21T00:00:00.000Z',
        callbackError: null,
        callbackDeliveredAt: null,
      }],
      total: 1,
      page: 1,
      limit: 20,
    });
  });

  it('applies department/workflow/status as equality filters and paginates via skip/take', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const service = new AutomationApprovalService({ prisma: { automationApproval: { findMany, count } } as never, now: () => NOW, hmacSecret: HMAC_SECRET });

    await service.listApprovals({ page: 2, limit: 10, department: 'sales', workflow: 'outreach', status: 'pending' });

    const expectedWhere = { department: 'sales', workflow: 'outreach', status: 'pending' };
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expectedWhere, skip: 10, take: 10, orderBy: { createdAt: 'desc' } }));
    expect(count).toHaveBeenCalledWith({ where: expectedWhere });
  });

  it('surfaces callbackError on rows where delivery failed, without requiring the decided state to be terminal', async () => {
    const findMany = vi.fn().mockResolvedValue([approvalRow({ status: 'approved', callbackError: 'http_503' })]);
    const count = vi.fn().mockResolvedValue(1);
    const service = new AutomationApprovalService({ prisma: { automationApproval: { findMany, count } } as never, now: () => NOW, hmacSecret: HMAC_SECRET });

    const result = await service.listApprovals({ page: 1, limit: 20 });
    expect(result.rows[0].callbackError).toBe('http_503');
  });
});

describe('AutomationApprovalService.createApproval / getApproval', () => {
  it('persists a pending approval and returns its id', async () => {
    const prisma = createFakePrisma();
    const service = new AutomationApprovalService({ prisma: prisma as never, now: () => NOW, hmacSecret: HMAC_SECRET });

    const { approvalId } = await service.createApproval(baseCreateInput());
    expect(prisma.rows.get(approvalId)?.status).toBe('pending');

    const status = await service.getApproval({ approvalId });
    expect(status).toEqual({ status: 'pending' });
  });

  it('throws NOT_FOUND for an unknown approvalId', async () => {
    const prisma = createFakePrisma();
    const service = new AutomationApprovalService({ prisma: prisma as never, now: () => NOW, hmacSecret: HMAC_SECRET });

    await expect(service.getApproval({ approvalId: 'does-not-exist' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is idempotent on idempotencyKey - a duplicate call (e.g. an n8n retry) returns the same approvalId and does not create a second row', async () => {
    const prisma = createFakePrisma();
    const service = new AutomationApprovalService({ prisma: prisma as never, now: () => NOW, hmacSecret: HMAC_SECRET });

    const first = await service.createApproval(baseCreateInput({ idempotencyKey: 'appr-exec-123' }));
    const second = await service.createApproval(baseCreateInput({ idempotencyKey: 'appr-exec-123' }));

    expect(second.approvalId).toBe(first.approvalId);
    expect(prisma.rows.size).toBe(1);
    expect(prisma.automationApproval.create).toHaveBeenCalledTimes(2);
  });

  it('sets expiresAt to 24h after creation', async () => {
    const prisma = createFakePrisma();
    const service = new AutomationApprovalService({ prisma: prisma as never, now: () => NOW, hmacSecret: HMAC_SECRET });

    const { approvalId } = await service.createApproval(baseCreateInput());
    expect(prisma.rows.get(approvalId)?.expiresAt).toEqual(new Date('2026-07-23T12:00:00.000Z'));
  });
});

describe('AutomationApprovalService.recordApprovalDecision', () => {
  it('updates status, signs the callback correctly, and delivers it', async () => {
    const prisma = createFakePrisma();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const service = new AutomationApprovalService({ prisma: prisma as never, fetchImpl, now: () => NOW, hmacSecret: HMAC_SECRET });

    const { approvalId } = await service.createApproval(baseCreateInput());
    const result = await service.recordApprovalDecision({ approvalId, decision: 'approved', by: 'admin_user_1' });

    expect(result).toEqual({ approvalId, status: 'approved' });
    expect(prisma.rows.get(approvalId)).toMatchObject({ status: 'approved', decidedBy: 'admin_user_1' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://agents.sheriabot.com/webhook/approval-callback');
    expect(init.method).toBe('POST');

    const timestampSeconds = Math.floor(NOW.getTime() / 1000);
    const expectedSignature = signApprovalCallback(HMAC_SECRET, { approvalId, decision: 'approved', timestampSeconds });
    expect((init.headers as Record<string, string>)['x-sheriabot-signature']).toBe(expectedSignature);
    expect((init.headers as Record<string, string>)['x-sheriabot-timestamp']).toBe(String(timestampSeconds));
    expect(JSON.parse(init.body as string)).toEqual({ approvalId, decision: 'approved', timestamp: timestampSeconds });
  });

  it('rejects a second decision on an already-decided approval (CONFLICT), leaving the first decision intact', async () => {
    const prisma = createFakePrisma();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const service = new AutomationApprovalService({ prisma: prisma as never, fetchImpl, now: () => NOW, hmacSecret: HMAC_SECRET });

    const { approvalId } = await service.createApproval(baseCreateInput());
    await service.recordApprovalDecision({ approvalId, decision: 'approved', by: 'admin_user_1' });

    await expect(
      service.recordApprovalDecision({ approvalId, decision: 'rejected', by: 'admin_user_2' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(prisma.rows.get(approvalId)?.status).toBe('approved');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws NOT_FOUND deciding an approval that does not exist', async () => {
    const prisma = createFakePrisma();
    const service = new AutomationApprovalService({ prisma: prisma as never, now: () => NOW, hmacSecret: HMAC_SECRET });

    await expect(
      service.recordApprovalDecision({ approvalId: 'does-not-exist', decision: 'approved', by: 'admin_user_1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('still persists the decision, without throwing, when callback delivery fails - n8n polling is the recovery path', async () => {
    const prisma = createFakePrisma();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network unreachable'));
    const service = new AutomationApprovalService({ prisma: prisma as never, fetchImpl, now: () => NOW, hmacSecret: HMAC_SECRET });

    const { approvalId } = await service.createApproval(baseCreateInput());
    const result = await service.recordApprovalDecision({ approvalId, decision: 'rejected', by: 'admin_user_1' });

    expect(result).toEqual({ approvalId, status: 'rejected' });
    const row = prisma.rows.get(approvalId);
    expect(row?.status).toBe('rejected');
    expect(row?.callbackError).toBe('network unreachable');
  });

  it('records callbackError (not a throw) on a non-2xx callback response', async () => {
    const prisma = createFakePrisma();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const service = new AutomationApprovalService({ prisma: prisma as never, fetchImpl, now: () => NOW, hmacSecret: HMAC_SECRET });

    const { approvalId } = await service.createApproval(baseCreateInput());
    await service.recordApprovalDecision({ approvalId, decision: 'approved', by: 'admin_user_1' });

    expect(prisma.rows.get(approvalId)?.callbackError).toBe('http_503');
  });

  it('throws BAD_REQUEST and flips status to expired for a PENDING row already past its expiresAt', async () => {
    const prisma = createFakePrisma();
    let clock = new Date('2026-07-22T00:00:00.000Z');
    const service = new AutomationApprovalService({ prisma: prisma as never, now: () => clock, hmacSecret: HMAC_SECRET });

    const { approvalId } = await service.createApproval(baseCreateInput());
    clock = new Date('2026-07-23T00:00:01.000Z'); // 1s past the 24h TTL

    await expect(
      service.recordApprovalDecision({ approvalId, decision: 'approved', by: 'admin_user_1' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(prisma.rows.get(approvalId)?.status).toBe('expired');
  });

  it('does not expire a PENDING row still within its TTL', async () => {
    const prisma = createFakePrisma();
    let clock = new Date('2026-07-22T00:00:00.000Z');
    const service = new AutomationApprovalService({ prisma: prisma as never, now: () => clock, hmacSecret: HMAC_SECRET });

    const { approvalId } = await service.createApproval(baseCreateInput());
    clock = new Date('2026-07-22T23:59:59.000Z'); // 1s before the 24h TTL

    const result = await service.recordApprovalDecision({ approvalId, decision: 'approved', by: 'admin_user_1' });
    expect(result).toEqual({ approvalId, status: 'approved' });
  });

  it('leaves a legacy row with a null expiresAt undecidable-by-expiry (safe by construction)', async () => {
    const prisma = createFakePrisma();
    const service = new AutomationApprovalService({ prisma: prisma as never, now: () => NOW, hmacSecret: HMAC_SECRET });

    prisma.rows.set('legacy_1', {
      id: 'legacy_1',
      status: 'pending',
      callbackUrl: 'https://agents.sheriabot.com/webhook/approval-callback',
      callbackError: null,
      callbackDeliveredAt: null,
      decidedBy: null,
      decidedAt: null,
      idempotencyKey: null,
      expiresAt: null,
    });

    const result = await service.recordApprovalDecision({ approvalId: 'legacy_1', decision: 'approved', by: 'admin_user_1' });
    expect(result).toEqual({ approvalId: 'legacy_1', status: 'approved' });
  });
});

describe('AutomationApprovalService.expireStalePendingApprovals', () => {
  it('ages out PENDING rows past expiresAt and leaves non-expired PENDING rows untouched', async () => {
    const prisma = createFakePrisma();
    let clock = new Date('2026-07-22T00:00:00.000Z');
    const service = new AutomationApprovalService({ prisma: prisma as never, now: () => clock, hmacSecret: HMAC_SECRET });

    const { approvalId: staleId } = await service.createApproval(baseCreateInput({ idempotencyKey: 'idem_stale' }));
    clock = new Date('2026-07-22T01:00:00.000Z');
    const { approvalId: freshId } = await service.createApproval(baseCreateInput({ idempotencyKey: 'idem_fresh' }));

    clock = new Date('2026-07-23T00:30:00.000Z'); // past staleId's 24h TTL, before freshId's

    const count = await service.expireStalePendingApprovals();

    expect(count).toBe(1);
    expect(prisma.rows.get(staleId)?.status).toBe('expired');
    expect(prisma.rows.get(freshId)?.status).toBe('pending');
  });

  it('does not touch already-decided rows even if their expiresAt has passed', async () => {
    const prisma = createFakePrisma();
    let clock = new Date('2026-07-22T00:00:00.000Z');
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const service = new AutomationApprovalService({ prisma: prisma as never, fetchImpl, now: () => clock, hmacSecret: HMAC_SECRET });

    const { approvalId } = await service.createApproval(baseCreateInput());
    await service.recordApprovalDecision({ approvalId, decision: 'approved', by: 'admin_user_1' });

    clock = new Date('2026-07-23T00:30:00.000Z'); // past the original 24h TTL

    const count = await service.expireStalePendingApprovals();
    expect(count).toBe(0);
    expect(prisma.rows.get(approvalId)?.status).toBe('approved');
  });

  it('leaves legacy rows with a null expiresAt untouched', async () => {
    const prisma = createFakePrisma();
    const service = new AutomationApprovalService({ prisma: prisma as never, now: () => NOW, hmacSecret: HMAC_SECRET });

    prisma.rows.set('legacy_1', {
      id: 'legacy_1',
      status: 'pending',
      callbackUrl: 'https://agents.sheriabot.com/webhook/approval-callback',
      callbackError: null,
      callbackDeliveredAt: null,
      decidedBy: null,
      decidedAt: null,
      idempotencyKey: null,
      expiresAt: null,
    });

    const count = await service.expireStalePendingApprovals();
    expect(count).toBe(0);
    expect(prisma.rows.get('legacy_1')?.status).toBe('pending');
  });
});
