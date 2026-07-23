import Fastify, { type FastifyInstance } from 'fastify';
import { TRPCError } from '@trpc/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerApprovalDecisionRoutes } from './approval-decision.route';
import { signApprovalDecisionLink } from '@/modules/agents/automation/approval-decision-link-signature';

// This file's first app.inject() call pays a one-time cold-start cost for the
// real module graph (prisma/resend/redis client construction pulled in via
// approval.service.ts's singleton, even though every test injects its own
// fakes over it) - bump the default so that cost doesn't trip the timeout.
vi.setConfig({ testTimeout: 20000 });

const SECRET = 'test-decision-link-secret-not-real';
const NOW = new Date('2026-07-22T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function buildApproval(overrides: Record<string, unknown> = {}) {
  return {
    status: 'pending',
    department: 'marketing',
    workflow: 'weekly-newsletter',
    summary: 'Weekly compliance digest ready for review.',
    reviewerEmail: 'reviewer@example.com',
    ...overrides,
  };
}

function buildApp(options: {
  approvalOverride?: Record<string, unknown> | null;
  recordDecisionImpl?: () => Promise<{ approvalId: string; status: string }>;
  allowRateLimit?: boolean;
} = {}): { app: FastifyInstance; getApprovalPublicView: ReturnType<typeof vi.fn>; recordApprovalDecision: ReturnType<typeof vi.fn>; rateLimitCheck: ReturnType<typeof vi.fn> } {
  const getApprovalPublicView = vi.fn().mockResolvedValue(
    options.approvalOverride === null ? null : buildApproval(options.approvalOverride ?? {}),
  );
  const recordApprovalDecision = vi.fn().mockImplementation(
    options.recordDecisionImpl ?? (async () => ({ approvalId: 'appr_1', status: 'approved' })),
  );
  const rateLimitCheck = vi.fn().mockResolvedValue({
    allowed: options.allowRateLimit ?? true,
    remaining: 10,
    resetAt: new Date(),
  });

  const app = Fastify();
  registerApprovalDecisionRoutes(app, {
    approvalService: { getApprovalPublicView, recordApprovalDecision } as never,
    decisionLinkSecret: SECRET,
    now: () => NOW,
    rateLimitCheck: rateLimitCheck as never,
  });

  return { app, getApprovalPublicView, recordApprovalDecision, rateLimitCheck };
}

function validToken(approvalId = 'appr_1', expiresAtSeconds = NOW_SECONDS + 3600) {
  const signature = signApprovalDecisionLink(SECRET, { approvalId, expiresAtSeconds });
  return { approvalId, exp: String(expiresAtSeconds), sig: signature };
}

describe('GET /approvals/decide', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it('(a) renders the confirmation page for a valid token, with zero mutating side effects', async () => {
    const built = buildApp();
    app = built.app;
    const token = validToken();

    const response = await app.inject({ method: 'GET', url: `/approvals/decide?approvalId=${token.approvalId}&exp=${token.exp}&sig=${token.sig}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Weekly compliance digest ready for review.');
    expect(response.body).toContain('marketing');
    expect(response.body).toContain('weekly-newsletter');
    expect(built.recordApprovalDecision).not.toHaveBeenCalled();
  });

  it('(c) rejects an expired token with 400 and does not call recordApprovalDecision', async () => {
    const built = buildApp();
    app = built.app;
    const token = validToken('appr_1', NOW_SECONDS - 1); // expired 1s ago

    const response = await app.inject({ method: 'GET', url: `/approvals/decide?approvalId=${token.approvalId}&exp=${token.exp}&sig=${token.sig}` });

    expect(response.statusCode).toBe(400);
    expect(built.recordApprovalDecision).not.toHaveBeenCalled();
  });

  it('(d) rejects a tampered signature with 400 and does not call recordApprovalDecision', async () => {
    const built = buildApp();
    app = built.app;
    const token = validToken();
    const tamperedSig = token.sig.slice(0, -2) + (token.sig.endsWith('ff') ? '00' : 'ff');

    const response = await app.inject({ method: 'GET', url: `/approvals/decide?approvalId=${token.approvalId}&exp=${token.exp}&sig=${tamperedSig}` });

    expect(response.statusCode).toBe(400);
    expect(built.recordApprovalDecision).not.toHaveBeenCalled();
  });

  it('(f) repeated / scanner-like GETs never trigger a decision, even across many requests', async () => {
    const built = buildApp();
    app = built.app;
    const token = validToken();
    const url = `/approvals/decide?approvalId=${token.approvalId}&exp=${token.exp}&sig=${token.sig}`;

    for (let i = 0; i < 5; i++) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
    }
    // Also probe with a malformed/tampered variant in the same burst.
    await app.inject({ method: 'GET', url: `/approvals/decide?approvalId=${token.approvalId}&exp=${token.exp}&sig=deadbeef` });

    expect(built.recordApprovalDecision).not.toHaveBeenCalled();
  });

  it('rejects a malformed query (missing sig) with 400', async () => {
    const built = buildApp();
    app = built.app;

    const response = await app.inject({ method: 'GET', url: '/approvals/decide?approvalId=appr_1&exp=1700000000' });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for a valid signature on an approval that no longer exists', async () => {
    const built = buildApp({ approvalOverride: null });
    app = built.app;
    const token = validToken();

    const response = await app.inject({ method: 'GET', url: `/approvals/decide?approvalId=${token.approvalId}&exp=${token.exp}&sig=${token.sig}` });
    expect(response.statusCode).toBe(404);
  });

  it('returns 429 and does not evaluate the token when rate limited', async () => {
    const built = buildApp({ allowRateLimit: false });
    app = built.app;
    const token = validToken();

    const response = await app.inject({ method: 'GET', url: `/approvals/decide?approvalId=${token.approvalId}&exp=${token.exp}&sig=${token.sig}` });
    expect(response.statusCode).toBe(429);
    expect(built.getApprovalPublicView).not.toHaveBeenCalled();
  });
});

describe('POST /approvals/decide', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it('(b) records the decision via recordApprovalDecision with decidedBy reflecting the email-link path', async () => {
    const built = buildApp({
      recordDecisionImpl: async () => ({ approvalId: 'appr_1', status: 'approved' }),
    });
    app = built.app;
    const token = validToken();

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/decide',
      payload: { approvalId: token.approvalId, exp: token.exp, sig: token.sig, decision: 'approved' },
    });

    expect(response.statusCode).toBe(200);
    expect(built.recordApprovalDecision).toHaveBeenCalledWith({
      approvalId: 'appr_1',
      decision: 'approved',
      by: 'email-link:reviewer@example.com',
    });
  });

  it('(c) rejects an expired token with 400 without calling recordApprovalDecision', async () => {
    const built = buildApp();
    app = built.app;
    const token = validToken('appr_1', NOW_SECONDS - 1);

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/decide',
      payload: { approvalId: token.approvalId, exp: token.exp, sig: token.sig, decision: 'approved' },
    });

    expect(response.statusCode).toBe(400);
    expect(built.recordApprovalDecision).not.toHaveBeenCalled();
  });

  it('(d) rejects a tampered signature with 400 without calling recordApprovalDecision', async () => {
    const built = buildApp();
    app = built.app;
    const token = validToken();
    const tamperedSig = token.sig.slice(0, -2) + (token.sig.endsWith('ff') ? '00' : 'ff');

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/decide',
      payload: { approvalId: token.approvalId, exp: token.exp, sig: tamperedSig, decision: 'approved' },
    });

    expect(response.statusCode).toBe(400);
    expect(built.recordApprovalDecision).not.toHaveBeenCalled();
  });

  it('(e) a valid signature for an already-decided approval is still rejected - recordApprovalDecision\'s own CONFLICT guard applies', async () => {
    const built = buildApp({
      recordDecisionImpl: async () => {
        throw new TRPCError({ code: 'CONFLICT', message: 'Approval already decided (status: approved).' });
      },
    });
    app = built.app;
    const token = validToken();

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/decide',
      payload: { approvalId: token.approvalId, exp: token.exp, sig: token.sig, decision: 'rejected' },
    });

    expect(response.statusCode).toBe(409);
    expect(built.recordApprovalDecision).toHaveBeenCalledTimes(1);
  });

  it('(e) a valid signature for an already-expired-in-the-DB approval is rejected via the BAD_REQUEST guard', async () => {
    const built = buildApp({
      recordDecisionImpl: async () => {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Approval appr_1 expired.' });
      },
    });
    app = built.app;
    const token = validToken();

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/decide',
      payload: { approvalId: token.approvalId, exp: token.exp, sig: token.sig, decision: 'approved' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an invalid decision value with 400', async () => {
    const built = buildApp();
    app = built.app;
    const token = validToken();

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/decide',
      payload: { approvalId: token.approvalId, exp: token.exp, sig: token.sig, decision: 'maybe' },
    });

    expect(response.statusCode).toBe(400);
    expect(built.recordApprovalDecision).not.toHaveBeenCalled();
  });

  it('falls back to "email-link:unknown" when the approval has no reviewerEmail on record', async () => {
    const built = buildApp({ approvalOverride: { reviewerEmail: null } });
    app = built.app;
    const token = validToken();

    await app.inject({
      method: 'POST',
      url: '/approvals/decide',
      payload: { approvalId: token.approvalId, exp: token.exp, sig: token.sig, decision: 'approved' },
    });

    expect(built.recordApprovalDecision).toHaveBeenCalledWith({
      approvalId: 'appr_1',
      decision: 'approved',
      by: 'email-link:unknown',
    });
  });

  it('returns 429 and does not call recordApprovalDecision when rate limited', async () => {
    const built = buildApp({ allowRateLimit: false });
    app = built.app;
    const token = validToken();

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/decide',
      payload: { approvalId: token.approvalId, exp: token.exp, sig: token.sig, decision: 'approved' },
    });

    expect(response.statusCode).toBe(429);
    expect(built.recordApprovalDecision).not.toHaveBeenCalled();
  });
});
