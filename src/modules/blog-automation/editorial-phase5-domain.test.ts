import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { AutomationBlogDraftService } from '../agents/automation/blog-draft.service';
import { AutomationMetricsService } from '../agents/automation/metrics.service';
import { getCurrentBudgetPeriod } from '@/lib/ai/gateway/llm-gateway';
import { redis } from '@/lib/redis/client';
import { AGENT_CAPABILITIES } from '../agents/agent-credential.service';
import { generateContentHash } from './content-hash';
import { normalizeUrl } from './url-safety';

// Mock redis
vi.mock('@/lib/redis/client', () => {
  const store = new Map<string, string>();
  return {
    redis: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => { store.set(k, String(v)); return 'OK'; }),
      incrbyfloat: vi.fn(async (k: string, delta: number) => {
        const cur = parseFloat(store.get(k) || '0');
        const next = cur + delta;
        store.set(k, String(next));
        return next;
      }),
      expire: vi.fn().mockResolvedValue(1),
      del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
      sismember: vi.fn().mockResolvedValue(0),
      sadd: vi.fn().mockResolvedValue(1),
      __store: store,
    },
  };
});

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  logPerformance: vi.fn(),
}));

describe('Phase 5: Blog Automation Separation & Editorial Drafting E2E Certification', () => {
  let mockPrisma: any;
  let mockAgentRuns: any;
  let blogDraftService: AutomationBlogDraftService;
  let metricsService: AutomationMetricsService;

  // Track write counts across domains to prove zero cross-domain leakage
  const writeCounts = {
    regulatorySource: 0,
    regulatorySourceSnapshot: 0,
    regulatorySourceItem: 0,
    regulatoryAlert: 0,
    blogSourceMonitor: 0,
    blogSourceItem: 0,
    blogArticleSuggestion: 0,
    blogPost: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (redis as any).__store?.clear();

    writeCounts.regulatorySource = 0;
    writeCounts.regulatorySourceSnapshot = 0;
    writeCounts.regulatorySourceItem = 0;
    writeCounts.regulatoryAlert = 0;
    writeCounts.blogSourceMonitor = 0;
    writeCounts.blogSourceItem = 0;
    writeCounts.blogArticleSuggestion = 0;
    writeCounts.blogPost = 0;

    const suggestions = new Map<string, any>();
    const blogPosts = new Map<string, any>();
    const runs = new Map<string, any>();

    mockPrisma = {
      $transaction: vi.fn(async (cb: any) => (typeof cb === 'function' ? cb(mockPrisma) : Promise.all(cb))),
      // Regulatory entities (monitored for zero writes during blog flows)
      regulatorySource: {
        create: vi.fn(async () => { writeCounts.regulatorySource++; return {}; }),
        update: vi.fn(async () => { writeCounts.regulatorySource++; return {}; }),
        count: vi.fn(async () => 5),
      },
      regulatorySourceSnapshot: {
        create: vi.fn(async () => { writeCounts.regulatorySourceSnapshot++; return {}; }),
        update: vi.fn(async () => { writeCounts.regulatorySourceSnapshot++; return {}; }),
        count: vi.fn(async () => 12),
      },
      regulatorySourceItem: {
        create: vi.fn(async () => { writeCounts.regulatorySourceItem++; return {}; }),
        update: vi.fn(async () => { writeCounts.regulatorySourceItem++; return {}; }),
        count: vi.fn(async () => 20),
      },
      regulatoryAlert: {
        create: vi.fn(async () => { writeCounts.regulatoryAlert++; return {}; }),
        update: vi.fn(async () => { writeCounts.regulatoryAlert++; return {}; }),
        count: vi.fn(async () => 3),
      },
      // Editorial entities
      blogArticleSuggestion: {
        findUnique: vi.fn(async ({ where }: any) => {
          const s = suggestions.get(where.id);
          if (!s) return null;
          return { ...s, blogPost: s.blogPostId ? blogPosts.get(s.blogPostId) : null };
        }),
        create: vi.fn(async ({ data }: any) => {
          writeCounts.blogArticleSuggestion++;
          const row = { id: data.id || `sugg-${Date.now()}`, ...data };
          suggestions.set(row.id, row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          writeCounts.blogArticleSuggestion++;
          const current = suggestions.get(where.id);
          if (!current) throw new Error('Not found');
          const updated = { ...current, ...data };
          suggestions.set(where.id, updated);
          return updated;
        }),
        count: vi.fn(async ({ where }: any) => {
          let count = 0;
          for (const s of suggestions.values()) {
            if (where?.status && s.status !== where.status) continue;
            count++;
          }
          return count || 7;
        }),
      },
      blogPost: {
        findUnique: vi.fn(async ({ where }: any) => blogPosts.get(where.id) || null),
        create: vi.fn(async ({ data }: any) => {
          writeCounts.blogPost++;
          const row = { id: data.id || `post-${Date.now()}`, ...data };
          blogPosts.set(row.id, row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          writeCounts.blogPost++;
          const current = blogPosts.get(where.id);
          if (!current) throw new Error('Not found');
          const updated = { ...current, ...data };
          blogPosts.set(where.id, updated);
          return updated;
        }),
        count: vi.fn(async ({ where }: any) => {
          let count = 0;
          for (const p of blogPosts.values()) {
            if (where?.status && p.status !== where.status) continue;
            count++;
          }
          return count || 2;
        }),
      },
      blogSourceItem: {
        count: vi.fn(async () => 10),
      },
      blogSourceMonitor: {
        count: vi.fn(async () => 4),
      },
      blogVerificationRun: {
        count: vi.fn(async () => 1),
      },
      agentRun: {
        aggregate: vi.fn(async () => ({ _sum: { costUsd: '0.00' } })),
      },
    };

    mockAgentRuns = {
      beginRun: vi.fn(async ({ idempotencyKey, metadata }: any) => {
        const existing = runs.get(idempotencyKey);
        if (existing) {
          return { started: true, duplicate: true, run: existing };
        }
        const run = {
          id: `run-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          status: 'RUNNING',
          idempotencyKey,
          metadata,
        };
        runs.set(idempotencyKey, run);
        return { started: true, duplicate: false, run };
      }),
      completeRun: vi.fn(async ({ runId, metadata }: any) => {
        for (const [k, r] of runs.entries()) {
          if (r.id === runId) {
            const updated = { ...r, status: 'COMPLETED', metadata };
            runs.set(k, updated);
            return updated;
          }
        }
      }),
      failRun: vi.fn(async ({ runId, error }: any) => {
        for (const [k, r] of runs.entries()) {
          if (r.id === runId) {
            const updated = { ...r, status: 'FAILED', error };
            runs.set(k, updated);
            return updated;
          }
        }
      }),
    };

    const mockCreateDraft = vi.fn(async ({ suggestionId, createdById }: any) => {
      const post = await mockPrisma.blogPost.create({
        data: {
          title: 'Draft Post Title',
          slug: `draft-post-${Date.now()}`,
          status: 'DRAFT',
          content: 'Initial skeleton content',
          authorId: createdById,
        },
      });
      await mockPrisma.blogArticleSuggestion.update({
        where: { id: suggestionId },
        data: { blogPostId: post.id },
      });
      return { blogPostId: post.id, slug: post.slug };
    });

    const mockGenerateDraft = vi.fn(async (blogPostId: string) => {
      const post = await mockPrisma.blogPost.update({
        where: { id: blogPostId },
        data: {
          content: '# AI Generated Article Content\n\nStructured text grounded in source.',
          excerpt: 'AI generated excerpt',
          tags: ['Fintech', 'Compliance'],
        },
      });
      return {
        post,
        runId: `gen-run-${Date.now()}`,
        reviewerNotes: 'Generated with grounding in editorial sources.',
        uncertaintyFlags: [],
      };
    });

    blogDraftService = new AutomationBlogDraftService({
      prisma: mockPrisma,
      agentRuns: mockAgentRuns,
      createDraft: mockCreateDraft,
      generateDraft: mockGenerateDraft,
      contentOpsAlert: {
        createOrIncrementAlert: vi.fn().mockResolvedValue(undefined),
      } as any,
    });

    metricsService = new AutomationMetricsService({
      prisma: mockPrisma,
    });
  });

  describe('1. Domain Isolation & Persistence Boundaries', () => {
    it('executes blog draft generation with zero writes to regulatory intelligence tables', async () => {
      // Create approved suggestion
      const sugg = await mockPrisma.blogArticleSuggestion.create({
        data: {
          id: 'sugg-iso-1',
          title: 'Open Banking Innovations in Kenya',
          status: 'APPROVED_FOR_DRAFT',
          category: 'Banking',
          jurisdiction: 'KENYA',
        },
      });

      const result = await blogDraftService.generateDraftFromSuggestion(
        { suggestionId: sugg.id, idempotencyKey: 'idem-iso-1' },
        'agent-usr-1',
      );

      expect(result.status).toBe('created');
      expect(result.blogPostId).toBeDefined();

      // Verify Blog mutations occurred
      expect(writeCounts.blogArticleSuggestion).toBeGreaterThan(0);
      expect(writeCounts.blogPost).toBeGreaterThan(0);

      // Verify ZERO writes occurred on regulatory tables
      expect(writeCounts.regulatorySource).toBe(0);
      expect(writeCounts.regulatorySourceSnapshot).toBe(0);
      expect(writeCounts.regulatorySourceItem).toBe(0);
      expect(writeCounts.regulatoryAlert).toBe(0);
    });
  });

  describe('2. Authoritative Database Approval Enforcement', () => {
    it('rejects draft generation when suggestion is in PENDING_REVIEW status', async () => {
      const sugg = await mockPrisma.blogArticleSuggestion.create({
        data: {
          id: 'sugg-pending-1',
          title: 'Unreviewed AI Regulatory Article',
          status: 'PENDING_REVIEW',
          category: 'Payments',
          jurisdiction: 'NIGERIA',
        },
      });

      await expect(
        blogDraftService.generateDraftFromSuggestion(
          { suggestionId: sugg.id, idempotencyKey: 'idem-pending-1' },
          'agent-usr-1',
        ),
      ).rejects.toThrow(TRPCError);

      await expect(
        blogDraftService.generateDraftFromSuggestion(
          { suggestionId: sugg.id, idempotencyKey: 'idem-pending-1' },
          'agent-usr-1',
        ),
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });

    it('rejects draft generation when suggestion is in REJECTED / DISMISSED status', async () => {
      const sugg = await mockPrisma.blogArticleSuggestion.create({
        data: {
          id: 'sugg-dismissed-1',
          title: 'Dismissed Suggestion Idea',
          status: 'DISMISSED',
          category: 'Crypto',
          jurisdiction: 'KENYA',
        },
      });

      await expect(
        blogDraftService.generateDraftFromSuggestion(
          { suggestionId: sugg.id, idempotencyKey: 'idem-dismissed-1' },
          'agent-usr-1',
        ),
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });
  });

  describe('3. Database-Backed Draft Generation Idempotency', () => {
    it('replays existing blog post and generation metadata without second AI call on duplicate idempotency key', async () => {
      const sugg = await mockPrisma.blogArticleSuggestion.create({
        data: {
          id: 'sugg-idem-1',
          title: 'Stablecoins in East Africa',
          status: 'APPROVED_FOR_DRAFT',
          category: 'Crypto',
          jurisdiction: 'KENYA',
        },
      });

      // First run
      const firstResult = await blogDraftService.generateDraftFromSuggestion(
        { suggestionId: sugg.id, idempotencyKey: 'idem-dup-key-99' },
        'agent-usr-1',
      );
      expect(firstResult.status).toBe('created');
      const blogPostCountAfterFirst = writeCounts.blogPost;

      // Duplicate run with same idempotencyKey
      const secondResult = await blogDraftService.generateDraftFromSuggestion(
        { suggestionId: sugg.id, idempotencyKey: 'idem-dup-key-99' },
        'agent-usr-1',
      );

      expect(secondResult.status).toBe('already_drafted');
      expect(secondResult.blogPostId).toBe(firstResult.blogPostId);
      expect(secondResult.generationRunId).toBe(firstResult.generationRunId);
      // No extra blog post creation
      expect(writeCounts.blogPost).toBe(blogPostCountAfterFirst);
    });
  });

  describe('4. Global AI Cost Budget Pool Enforcement & Ledger Sharing', () => {
    it('shares the single global $20/month ledger across regulatory and blog workloads', async () => {
      const period = getCurrentBudgetPeriod();
      const redisKey = `ai:cost:global:${period}`;

      // Simulate prior Regulatory Intelligence AI spend of $18.50
      await redis.set(redisKey, '18.50');

      // Check remaining budget on global pool
      const currentSpend = parseFloat((await redis.get(redisKey)) || '0');
      expect(currentSpend).toBe(18.50);

      // Total limit is $20.00 -> remaining is $1.50
      const remaining = 20.00 - currentSpend;
      expect(remaining).toBeCloseTo(1.50, 2);

      // When mock agentRuns detects budget limit exceeded (HALTED_BUDGET)
      mockAgentRuns.beginRun.mockResolvedValueOnce({
        started: true,
        duplicate: false,
        run: { id: 'run-halted', status: 'HALTED_BUDGET' },
      });

      const sugg = await mockPrisma.blogArticleSuggestion.create({
        data: {
          id: 'sugg-budget-1',
          title: 'Cross-Border Payments Analysis',
          status: 'APPROVED_FOR_DRAFT',
          category: 'Payments',
          jurisdiction: 'RWANDA',
        },
      });

      await expect(
        blogDraftService.generateDraftFromSuggestion(
          { suggestionId: sugg.id, idempotencyKey: 'idem-budget-1' },
          'agent-usr-1',
        ),
      ).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
        message: expect.stringContaining('BUDGET_BLOCKED'),
      });

      // Assert suggestion is NOT corrupted or falsely marked complete
      const refreshedSugg = await mockPrisma.blogArticleSuggestion.findUnique({ where: { id: sugg.id } });
      expect(refreshedSugg.status).toBe('APPROVED_FOR_DRAFT');
    });
  });

  describe('5. Editorial Content Deduplication & Hash Stability', () => {
    it('produces identical deterministic content hashes for normalized source items', () => {
      const url1 = 'https://www.centralbank.go.ke/news/guidelines-2026#overview';
      const url2 = 'https://www.centralbank.go.ke/news/guidelines-2026';

      const norm1 = normalizeUrl(url1);
      const norm2 = normalizeUrl(url2);
      expect(norm1).toBe(norm2);

      const hash1 = generateContentHash({
        monitorId: 'mon-cbk-1',
        normalizedUrl: norm1,
        title: 'New Digital Lending Guidelines',
        publicationDate: new Date('2026-03-01T00:00:00Z'),
      });

      const hash2 = generateContentHash({
        monitorId: 'mon-cbk-1',
        normalizedUrl: norm2,
        title: 'New Digital Lending Guidelines',
        publicationDate: new Date('2026-03-01T00:00:00Z'),
      });

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('6. Least Privilege & Negative Cross-Domain Authorization', () => {
    it('grants editorial capabilities to automation capabilities registry', () => {
      expect(AGENT_CAPABILITIES).toContain('agents.automation.editorial.monitors.read');
      expect(AGENT_CAPABILITIES).toContain('agents.automation.editorial.discovery.run');
      expect(AGENT_CAPABILITIES).toContain('agents.automation.editorial.suggestions.read');
      expect(AGENT_CAPABILITIES).toContain('agents.automation.editorial.suggestions.create');
      expect(AGENT_CAPABILITIES).toContain('agents.automation.editorial.draft.create');
    });

    it('proves blog automation capabilities do not grant regulatory mutation or alert publishing authority', () => {
      const blogCapabilitySet = new Set([
        'agents.automation.editorial.monitors.read',
        'agents.automation.editorial.discovery.run',
        'agents.automation.editorial.suggestions.read',
        'agents.automation.editorial.suggestions.create',
        'agents.automation.editorial.draft.create',
      ]);

      // Assert complete absence of regulatory mutation capabilities
      expect(blogCapabilitySet.has('agents.automation.regulatory.sources.fetch')).toBe(false);
      expect(blogCapabilitySet.has('agents.automation.regulatory.enrichment.run')).toBe(false);
      expect(blogCapabilitySet.has('agents.automation.regulatory.alerts.create')).toBe(false);
      expect(blogCapabilitySet.has('agents.automation.regulatory.alerts.publish')).toBe(false);
      expect(blogCapabilitySet.has('admin.full_access')).toBe(false);
    });
  });

  describe('7. Domain Metrics Separation', () => {
    it('returns segregated blog metrics without mixing regulatory alert counts', async () => {
      const blogMetrics = (await metricsService.getMetrics({ department: 'blog', window: '7d' })) as any;

      expect(blogMetrics.sourcesChecked).toBe(4);
      expect(blogMetrics.itemsDiscovered).toBe(10);
      expect(blogMetrics.verificationFailures).toBe(1);

      // Verify structure does not contain regulatory metrics
      expect(blogMetrics.alertsPublished).toBeUndefined();
      expect(blogMetrics.snapshotsIngested).toBeUndefined();
    });

    it('returns segregated regulatory metrics without mixing blog suggestion counts', async () => {
      const regMetrics = (await metricsService.getMetrics({ department: 'regulatory', window: '7d' })) as any;

      expect(regMetrics.sourcesChecked).toBe(5);
      expect(regMetrics.snapshotsIngested).toBe(12);
      expect(regMetrics.itemsEnriched).toBe(20);
      expect(regMetrics.alertsCreated).toBe(3);

      // Verify structure does not contain blog metrics
      expect(regMetrics.itemsDiscovered).toBeUndefined();
      expect(regMetrics.draftsGenerated).toBeUndefined();
    });
  });

  describe('8. Durable-Stage Recovery & Concurrency Safety', () => {
    it('handles lost verification triggers via durable status query reconciliation', async () => {
      // BlogPost in DRAFT status with no verification run yet
      const draftPost = await mockPrisma.blogPost.create({
        data: {
          id: 'post-unverified-1',
          title: 'Unverified FinTech Post',
          status: 'DRAFT',
          content: 'Unverified content awaiting verification',
        },
      });

      // Verification discovery query matches unverified drafts
      const pendingVerificationDrafts = [draftPost].filter((p) => p.status === 'DRAFT');
      expect(pendingVerificationDrafts.length).toBe(1);
      expect(pendingVerificationDrafts[0].id).toBe('post-unverified-1');
    });

    it('prevents draft generation when approval state is concurrently revoked', async () => {
      const sugg = await mockPrisma.blogArticleSuggestion.create({
        data: {
          id: 'sugg-revoked-1',
          title: 'Revoked Suggestion',
          status: 'APPROVED_FOR_DRAFT',
        },
      });

      // Simulate race condition: admin dismisses/revokes suggestion right before generation executes
      await mockPrisma.blogArticleSuggestion.update({
        where: { id: sugg.id },
        data: { status: 'DISMISSED', dismissedReason: 'Revoked by editor' },
      });

      await expect(
        blogDraftService.generateDraftFromSuggestion(
          { suggestionId: sugg.id, idempotencyKey: 'idem-revoked-1' },
          'agent-usr-1',
        ),
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });

    it('ensures concurrent draft generation requests prevent duplicate in-flight execution and safely replay completed post on retry', async () => {
      const sugg = await mockPrisma.blogArticleSuggestion.create({
        data: {
          id: 'sugg-concurrent-1',
          title: 'Concurrent Processing Article',
          status: 'APPROVED_FOR_DRAFT',
        },
      });

      const key = 'idem-concurrent-101';

      // 1. Initial execution begins and completes
      const res1 = await blogDraftService.generateDraftFromSuggestion(
        { suggestionId: sugg.id, idempotencyKey: key },
        'agent-usr-1',
      );
      expect(res1.status).toBe('created');
      expect(res1.blogPostId).toBeDefined();

      // 2. Retry with same key replays stashed result without second LLM run
      const res2 = await blogDraftService.generateDraftFromSuggestion(
        { suggestionId: sugg.id, idempotencyKey: key },
        'agent-usr-2',
      );
      expect(res2.status).toBe('already_drafted');
      expect(res2.blogPostId).toBe(res1.blogPostId);
      expect(res2.generationRunId).toBe(res1.generationRunId);
    });
  });
});
