import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { idempotencyPlugin } from '../idempotency.plugin';

const inMemoryStore = new Map<string, string>();

// Mock Redis at top level
vi.mock('../../lib/redis/client', () => ({
  redis: {
    get: vi.fn(async (key: string) => {
      const val = inMemoryStore.get(key);
      return val ? JSON.parse(val) : null;
    }),
    set: vi.fn(async (key: string, value: string, opts?: { nx?: boolean; ex?: number }) => {
      if (opts?.nx && inMemoryStore.has(key)) {
        return null;
      }
      inMemoryStore.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      inMemoryStore.delete(key);
      return 1;
    }),
  },
}));

vi.mock('../../lib/prisma/client', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => null),
    },
  },
}));

vi.mock('../../server/trpc/context', () => ({
  verifySupabaseTokenLocally: vi.fn(async () => ({ status: 'FALLBACK_REQUIRED' })),
}));

describe('F-09: REST Idempotency-Key Middleware', () => {
  let app: ReturnType<typeof Fastify>;
  let paymentCallCount = 0;
  let nonPaymentCallCount = 0;

  beforeEach(async () => {
    inMemoryStore.clear();
    paymentCallCount = 0;
    nonPaymentCallCount = 0;

    app = Fastify();

    // Hook to simulate verified session on request.user
    app.addHook('onRequest', async (req) => {
      const orgHeader = req.headers['test-session-org-id'];
      if (typeof orgHeader === 'string') {
        req.user = {
          id: 'usr_123',
          organizationId: orgHeader,
        };
      }
    });

    await app.register(idempotencyPlugin);

    // Mock payment/checkout route
    app.post('/api/checkout', async (request, reply) => {
      paymentCallCount++;
      const body = request.body as any;
      if (body?.statusCode) {
        return reply.status(body.statusCode).send({ error: `Payment failed with status ${body.statusCode}` });
      }
      if (body?.setCookie) {
        reply.header('set-cookie', 'session=abc; Path=/; HttpOnly');
      }
      return reply.status(200).send({ success: true, checkoutId: 'chk_123', count: paymentCallCount });
    });

    // Mock non-payment mutation route
    app.post('/api/user/profile', async () => {
      nonPaymentCallCount++;
      return { success: true, count: nonPaymentCallCount };
    });

    await app.ready();
  });

  it('executes handler once and returns cached response for duplicate Idempotency-Key on 2xx', async () => {
    const key = 'test-idempotency-key-1';
    const orgId = 'org_123';

    // First request: executes handler
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: {
        'idempotency-key': key,
        'test-session-org-id': orgId,
      },
      payload: { plan: 'STARTUP' },
    });

    expect(res1.statusCode).toBe(200);
    expect(paymentCallCount).toBe(1);
    const body1 = JSON.parse(res1.body);
    expect(body1.success).toBe(true);
    expect(body1.count).toBe(1);

    // Second request with same idempotency key: returns cached response
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: {
        'idempotency-key': key,
        'test-session-org-id': orgId,
      },
      payload: { plan: 'STARTUP' },
    });

    expect(res2.statusCode).toBe(200);
    expect(paymentCallCount).toBe(1); // Handler was NOT called a second time
    const body2 = JSON.parse(res2.body);
    expect(body2.success).toBe(true);
    expect(body2.count).toBe(1);
    expect(res2.headers['x-cache-lookup']).toBe('HIT');
  });

  it('is a no-op when Idempotency-Key header is absent', async () => {
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'test-session-org-id': 'org_123' },
      payload: { plan: 'STARTUP' },
    });
    expect(res1.statusCode).toBe(200);
    expect(paymentCallCount).toBe(1);

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: { 'test-session-org-id': 'org_123' },
      payload: { plan: 'STARTUP' },
    });
    expect(res2.statusCode).toBe(200);
    expect(paymentCallCount).toBe(2); // Handler executed again
  });

  it('fails open without caching if no verified organization session is available', async () => {
    const key = 'test-idempotency-no-auth';

    // No verified session attached to request
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: {
        'idempotency-key': key,
      },
      payload: { plan: 'STARTUP' },
    });
    expect(res1.statusCode).toBe(200);
    expect(paymentCallCount).toBe(1);

    // Second request: handler runs again because no verified org session was present to cache
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: {
        'idempotency-key': key,
      },
      payload: { plan: 'STARTUP' },
    });
    expect(res2.statusCode).toBe(200);
    expect(paymentCallCount).toBe(2);
    expect(res2.headers['x-cache-lookup']).toBeUndefined();
  });

  it('rejects Idempotency-Key longer than 255 characters with 400 Bad Request', async () => {
    const longKey = 'a'.repeat(256);

    const res = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: {
        'idempotency-key': longKey,
        'test-session-org-id': 'org_123',
      },
      payload: { plan: 'STARTUP' },
    });

    expect(res.statusCode).toBe(400);
    expect(paymentCallCount).toBe(0);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('must not exceed 255 characters');
  });

  it('scopes idempotency only to payment/checkout routes and ignores non-payment mutations', async () => {
    const key = 'test-idempotency-non-payment';

    const res1 = await app.inject({
      method: 'POST',
      url: '/api/user/profile',
      headers: {
        'idempotency-key': key,
        'test-session-org-id': 'org_123',
      },
      payload: { name: 'Alice' },
    });
    expect(res1.statusCode).toBe(200);
    expect(nonPaymentCallCount).toBe(1);

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/user/profile',
      headers: {
        'idempotency-key': key,
        'test-session-org-id': 'org_123',
      },
      payload: { name: 'Alice' },
    });
    expect(res2.statusCode).toBe(200);
    expect(nonPaymentCallCount).toBe(2); // Handler ran twice: no caching
    expect(res2.headers['x-cache-lookup']).toBeUndefined();
  });

  it('returns 409 Conflict with Retry-After header when a request is in flight', async () => {
    const key = 'test-idempotency-key-in-flight';
    const orgId = 'org_123';

    // Pre-populate in-flight/pending state in Redis
    inMemoryStore.set(
      `sheriabot:idempotency:${orgId}:${key}`,
      JSON.stringify({ status: 'pending', createdAt: Date.now() }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: {
        'idempotency-key': key,
        'test-session-org-id': orgId,
      },
      payload: { plan: 'STARTUP' },
    });

    expect(res.statusCode).toBe(409);
    expect(paymentCallCount).toBe(0);
    expect(res.headers['retry-after']).toBe('2');
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/concurrent request|in progress/i);
  });

  it('excludes Set-Cookie header from cached replay responses', async () => {
    const key = 'test-idempotency-cookie';
    const orgId = 'org_123';

    // First request sets a cookie
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: {
        'idempotency-key': key,
        'test-session-org-id': orgId,
      },
      payload: { plan: 'STARTUP', setCookie: true },
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers['set-cookie']).toBeDefined();

    // Replay request must NOT have set-cookie
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: {
        'idempotency-key': key,
        'test-session-org-id': orgId,
      },
      payload: { plan: 'STARTUP', setCookie: true },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers['x-cache-lookup']).toBe('HIT');
    expect(res2.headers['set-cookie']).toBeUndefined();
  });

  it('releases lock and re-invokes handler when first response is 400 (non-2xx policy)', async () => {
    const key = 'test-idempotency-key-400';
    const orgId = 'org_123';

    // First request returns 400 Bad Request
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: {
        'idempotency-key': key,
        'test-session-org-id': orgId,
      },
      payload: { statusCode: 400 },
    });
    expect(res1.statusCode).toBe(400);
    expect(paymentCallCount).toBe(1);

    // Lock must be released so second call re-invokes handler
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: {
        'idempotency-key': key,
        'test-session-org-id': orgId,
      },
      payload: { statusCode: null },
    });
    expect(res2.statusCode).toBe(200);
    expect(paymentCallCount).toBe(2); // Handler was executed again
    const body2 = JSON.parse(res2.body);
    expect(body2.success).toBe(true);
  });

  it('releases lock and re-invokes handler when first response is 500 (non-2xx policy)', async () => {
    const key = 'test-idempotency-key-500';
    const orgId = 'org_123';

    // First request returns 500 Internal Server Error
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: {
        'idempotency-key': key,
        'test-session-org-id': orgId,
      },
      payload: { statusCode: 500 },
    });
    expect(res1.statusCode).toBe(500);
    expect(paymentCallCount).toBe(1);

    // Lock must be released so second call re-invokes handler
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: {
        'idempotency-key': key,
        'test-session-org-id': orgId,
      },
      payload: { statusCode: null },
    });
    expect(res2.statusCode).toBe(200);
    expect(paymentCallCount).toBe(2); // Handler was executed again
    const body2 = JSON.parse(res2.body);
    expect(body2.success).toBe(true);
  });

  it('isolates idempotency keys by tenant organization ID', async () => {
    const key = 'shared-key-value';

    // Org A request
    const resA = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: {
        'idempotency-key': key,
        'test-session-org-id': 'org_A',
      },
      payload: { plan: 'STARTUP' },
    });

    expect(resA.statusCode).toBe(200);
    expect(paymentCallCount).toBe(1);

    // Org B request with same key: must NOT get Org A's response, must execute handler
    const resB = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      headers: {
        'idempotency-key': key,
        'test-session-org-id': 'org_B',
      },
      payload: { plan: 'STARTUP' },
    });

    expect(resB.statusCode).toBe(200);
    expect(paymentCallCount).toBe(2); // Org B got its own execution
  });
});
