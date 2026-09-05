import { describe, it, expect, vi, beforeEach } from 'vitest';
import { blogAutomationRouter } from './blog-automation.router';
import { TRPCError } from '@trpc/server';

describe('blogAutomationRouter.adminListSuggestions', () => {
  const mockFindMany = vi.fn();
  const mockCount = vi.fn();

  const mockPrisma = {
    blogArticleSuggestion: {
      findMany: mockFindMany,
      count: mockCount,
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  } as any;

  const adminCtx = {
    user: { id: 'admin-1', email: 'admin@sheriabot.com', role: 'ADMIN' },
    req: { ip: '127.0.0.1' },
    prisma: mockPrisma,
  };

  const userCtx = {
    user: { id: 'user-1', email: 'user@sheriabot.com', role: 'USER' },
    req: { ip: '127.0.0.1' },
    prisma: mockPrisma,
  };

  const unauthCtx = {
    user: null,
    req: { ip: '127.0.0.1' },
    prisma: mockPrisma,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);
  });

  it('denies access to unauthenticated requests', async () => {
    const caller = blogAutomationRouter.createCaller(unauthCtx as any);
    await expect(caller.adminListSuggestions({})).rejects.toThrow(TRPCError);
  });

  it('denies access to non-admin users', async () => {
    const caller = blogAutomationRouter.createCaller(userCtx as any);
    await expect(caller.adminListSuggestions({})).rejects.toThrow(TRPCError);
  });

  it('defaults to deterministic score descending sort order with secondary tie-breakers', async () => {
    const caller = blogAutomationRouter.createCaller(adminCtx as any);
    await caller.adminListSuggestions({});

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { relevanceScore: 'desc' },
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
      })
    );
  });

  it('supports score ascending sort order', async () => {
    const caller = blogAutomationRouter.createCaller(adminCtx as any);
    await caller.adminListSuggestions({ sortBy: 'score', sortOrder: 'asc' });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { relevanceScore: 'asc' },
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
      })
    );
  });

  it('supports relevanceScore sorting key', async () => {
    const caller = blogAutomationRouter.createCaller(adminCtx as any);
    await caller.adminListSuggestions({ sortBy: 'relevanceScore', sortOrder: 'desc' });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { relevanceScore: 'desc' },
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
      })
    );
  });

  it('supports date (createdAt) newest and oldest sorting', async () => {
    const caller = blogAutomationRouter.createCaller(adminCtx as any);
    
    // Newest
    await caller.adminListSuggestions({ sortBy: 'createdAt', sortOrder: 'desc' });
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
      })
    );

    // Oldest
    await caller.adminListSuggestions({ sortBy: 'createdAt', sortOrder: 'asc' });
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { createdAt: 'asc' },
          { id: 'desc' },
        ],
      })
    );
  });

  it('filters accurately by individual jurisdictions (KE, RW, MW, NG)', async () => {
    const caller = blogAutomationRouter.createCaller(adminCtx as any);

    for (const jurisdiction of ['KE', 'RW', 'MW', 'NG'] as const) {
      await caller.adminListSuggestions({ jurisdiction });
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ jurisdiction }),
        })
      );
    }
  });

  it('filters by minScore and maxScore range', async () => {
    const caller = blogAutomationRouter.createCaller(adminCtx as any);
    await caller.adminListSuggestions({ minScore: 70, maxScore: 85 });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          relevanceScore: { gte: 70, lte: 85 },
        }),
      })
    );
  });

  it('rejects invalid score range where minScore > maxScore through Zod validation', async () => {
    const caller = blogAutomationRouter.createCaller(adminCtx as any);
    await expect(
      caller.adminListSuggestions({ minScore: 90, maxScore: 50 })
    ).rejects.toThrow();
  });

  it('filters by authorityType via sources relation', async () => {
    const caller = blogAutomationRouter.createCaller(adminCtx as any);
    await caller.adminListSuggestions({ authorityType: 'CENTRAL_BANK' });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sources: {
            some: {
              sourceItem: {
                authorityType: 'CENTRAL_BANK',
              },
            },
          },
        }),
      })
    );
  });

  it('combines multiple filters (jurisdiction + score + status + pagination)', async () => {
    const caller = blogAutomationRouter.createCaller(adminCtx as any);
    await caller.adminListSuggestions({
      jurisdiction: 'RW',
      minScore: 85,
      status: 'PENDING_REVIEW',
      page: 2,
      limit: 10,
    });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 10,
        take: 10,
        where: expect.objectContaining({
          jurisdiction: 'RW',
          status: 'PENDING_REVIEW',
          relevanceScore: { gte: 85 },
        }),
      })
    );
  });
});
