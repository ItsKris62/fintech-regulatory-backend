import { describe, expect, it, vi } from 'vitest';
import { createContext } from '@/server/trpc/context';
import { publicMarketingRouter } from '../publicMarketing.router';
import { prisma } from '@/lib/prisma/client';

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    auth: {
      admin: { getUser: vi.fn(), signOut: vi.fn() },
      getUser: vi.fn(),
    },
  },
  supabaseClient: {},
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(0),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('@/lib/redis/rate-limiter', () => ({
  rateLimiter: {
    check: vi.fn().mockResolvedValue({ allowed: true }),
  },
}));

describe('Public Marketing: Unauthenticated ctx.tenantPrisma Behavior', () => {
  it('proves public routes execute successfully with unauthenticated ctx (user is null)', async () => {
    // 1. Create context for public unauthenticated request
    const dummyReq = {
      headers: {},
      ip: '127.0.0.1',
    } as any;
    const dummyRes = {} as any;

    const ctx = await createContext({ req: dummyReq, res: dummyRes });

    expect(ctx.user).toBeNull();
    expect(ctx.tenantPrisma).toBeDefined();

    // 2. Mock campaignSend lookup for public unsubscribe token validation
    vi.spyOn(prisma.campaignSend, 'findFirst').mockResolvedValue({
      id: 'send_public_123',
      unsubscribeTokenHash: 'mock-hash',
      unsubscribedAt: null,
      contact: { email: 'public.visitor@example.com' },
    } as any);

    const caller = publicMarketingRouter.createCaller(ctx);
    const result = await caller.validateUnsubscribeToken({ token: 'test-token-xyz' });

    expect(result.valid).toBe(true);
    expect(result.email).toBe('public.visitor@example.com');
  });

  it('proves ctx.tenantPrisma safely allows non-tenant models but hard-rejects tenant-scoped models when unauthenticated', async () => {
    const dummyReq = { headers: {}, ip: '127.0.0.1' } as any;
    const dummyRes = {} as any;
    const ctx = await createContext({ req: dummyReq, res: dummyRes });

    // Unauthenticated context has user: null
    expect(ctx.user).toBeNull();

    // Tenant model access with unauthenticated context MUST throw
    await expect(
      ctx.tenantPrisma.legalDocument.findMany({ where: {} } as any)
    ).rejects.toThrow(/Tenant context error: orgId is missing from context/);

    await expect(
      ctx.tenantPrisma.policy.findFirst({ where: {} } as any)
    ).rejects.toThrow(/Tenant context error: orgId is missing from context/);
  });
});
