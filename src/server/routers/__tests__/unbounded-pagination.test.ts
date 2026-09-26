import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

vi.mock('@/modules/billing/resolve-effective-plan', () => ({
  resolveEffectivePlan: vi.fn().mockResolvedValue({
    plan: 'ENTERPRISE',
    source: 'ORGANIZATION',
    entitlementProfile: null,
    entitlements: {},
    appliedOverrides: [],
    pilotState: null,
  }),
}));

const mockFindManyFrameworks = vi.fn();
const mockFindManyPasskeys = vi.fn();
const mockFindManyBlogPosts = vi.fn();

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    regulatoryFramework: {
      findMany: (...args: any[]) => mockFindManyFrameworks(...args),
    },
    passkey: {
      findMany: (...args: any[]) => mockFindManyPasskeys(...args),
    },
    blogPost: {
      findMany: (...args: any[]) => mockFindManyBlogPosts(...args),
      count: vi.fn().mockResolvedValue(1000),
    },
    customFramework: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    organization: {
      findUnique: vi.fn().mockResolvedValue({ id: 'org_1', name: 'Test Org' }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'usr_1', organizationId: 'org_1', role: 'ADMIN', totpEnabled: true }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit_1' }),
    },
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  },
}));

import { frameworkRouter } from '../framework.router';
import { passkeyRouter } from '../passkey.router';
import { blogRouter } from '../blog.router';

describe('F-12: Unbounded pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindManyFrameworks.mockImplementation(({ take }: any = {}) => {
      const count = take ?? 1000;
      return Array.from({ length: count }, (_, i) => ({
        id: `fw_${i}`,
        slug: `slug_${i}`,
        name: `Framework ${i}`,
        tier: 'FREE',
        isActive: true,
        sortOrder: i,
      }));
    });
    mockFindManyPasskeys.mockImplementation(({ take }: any = {}) => {
      const count = take ?? 1000;
      return Array.from({ length: count }, (_, i) => ({
        id: `pk_${i}`,
        deviceName: `Key ${i}`,
        transports: [],
        backedUp: false,
        createdAt: new Date(),
        lastUsedAt: null,
      }));
    });
    mockFindManyBlogPosts.mockImplementation(({ take }: any = {}) => {
      const count = take ?? 1000;
      return Array.from({ length: count }, (_, i) => ({
        id: `post_${i}`,
        title: `Post ${i}`,
        slug: `post-${i}`,
        excerpt: 'Excerpt',
        category: 'Compliance',
        tags: ['tag'],
        featured: false,
        coverImageUrl: null,
        publishedAt: new Date(),
        updatedAt: new Date(),
        lastReviewedAt: null,
        content: 'Content',
        author: { id: 'a1', fullName: 'Author' },
        _count: { sources: 0 },
      }));
    });
  });

  it('framework.list bounds take to at most 100 or rejects limit: 10000', async () => {
    const { prisma } = await import('@/lib/prisma/client');
    const ctx: any = {
      user: { id: 'usr_1', role: 'ADMIN', organizationId: 'org_1', totpEnabled: true },
      plan: 'ENTERPRISE',
      entitlements: {},
      prisma,
      tenantPrisma: {
        legalDocument: {
          groupBy: vi.fn().mockResolvedValue([]),
        },
      },
      req: { ip: '127.0.0.1', headers: {} },
    };

    const caller = frameworkRouter.createCaller(ctx);

    try {
      const res = await caller.list({ limit: 10000 } as any);
      expect(res.length).toBeLessThanOrEqual(100);
    } catch (err: any) {
      expect(err).toBeInstanceOf(TRPCError);
      expect(err.code).toBe('BAD_REQUEST');
    }
  });

  it('passkey.listUserPasskeys bounds take to at most 100 or rejects limit: 10000', async () => {
    const { prisma } = await import('@/lib/prisma/client');
    const ctx: any = {
      user: { id: 'usr_1', role: 'ADMIN', organizationId: 'org_1', totpEnabled: true },
      prisma,
      req: { ip: '127.0.0.1', headers: {} },
    };

    const caller = passkeyRouter.createCaller(ctx);

    try {
      const res = await (caller as any).listUserPasskeys({ limit: 10000 });
      expect(res.length).toBeLessThanOrEqual(100);
    } catch (err: any) {
      expect(err).toBeInstanceOf(TRPCError);
      expect(err.code).toBe('BAD_REQUEST');
    }
  });

  it('blog.publicList bounds limit to at most 100 or rejects limit: 10000', async () => {
    const { prisma } = await import('@/lib/prisma/client');
    const ctx: any = {
      prisma,
      req: { ip: '127.0.0.1', headers: {} },
    };

    const caller = blogRouter.createCaller(ctx);

    try {
      const res = await caller.publicList({ limit: 10000 } as any);
      expect(res.posts.length).toBeLessThanOrEqual(100);
    } catch (err: any) {
      expect(err).toBeInstanceOf(TRPCError);
      expect(err.code).toBe('BAD_REQUEST');
    }
  });
});
