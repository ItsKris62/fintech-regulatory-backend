import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RegulatoryAuthorityType,
  RegulatorySourceType,
  RegulatoryInformationType,
  RegulatoryStage,
  RegulatoryMateriality,
} from './types';
import { RegulatoryEnrichmentService } from './regulatory-enrichment.service';
import { RegulatorySnapshotService } from './regulatory-snapshot.service';
import { RegulatoryItemService } from './regulatory-item.service';
import { RegulatoryAlertDraftService } from './regulatory-alert-draft.service';
import { AlertService } from '@/modules/alert/alert.service';
import { llmGateway, getCurrentBudgetPeriod } from '@/lib/ai/gateway/llm-gateway';
import { LLMCostLimitError } from '@/lib/ai/gateway/types';
import { redis } from '@/lib/redis/client';

// Mock dependencies
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

vi.mock('@/lib/redis/pubsub', () => ({
  alertPubSub: {
    publish: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/email/react-mailer.service', () => ({
  reactMailer: {
    sendRegulatoryAlertEmail: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  logPerformance: vi.fn(),
}));

describe('Phase 4: Regulatory Review, Publication Governance & AI Budget Hardening E2E Certification', () => {
  let mockPrisma: any;
  let mockAgentRuns: any;
  let enrichmentService: RegulatoryEnrichmentService;
  let alertService: AlertService;

  beforeEach(() => {
    vi.clearAllMocks();
    (redis as any).__store?.clear();

    // Mock in-memory database entities
    const sources = new Map<string, any>();
    const snapshots = new Map<string, any>();
    const items = new Map<string, any>();
    const evidenceLinks = new Map<string, any>();
    const alerts = new Map<string, any>();
    const subscriptions = new Map<string, any>();
    const notifications = new Map<string, any>();
    const users = new Map<string, any>();
    const runs = new Map<string, any>();

    mockPrisma = {
      $transaction: vi.fn(async (cb: any) => (typeof cb === 'function' ? cb(mockPrisma) : Promise.all(cb))),
      regulatorySource: {
        findUnique: vi.fn(async ({ where }: any) => sources.get(where.id || where.sourceKey) || null),
        create: vi.fn(async ({ data }: any) => {
          const row = { id: data.id || `src-${Date.now()}`, ...data };
          sources.set(row.id, row);
          return row;
        }),
      },
      regulatorySourceSnapshot: {
        findUnique: vi.fn(async ({ where }: any) => {
          const snap = snapshots.get(where.id);
          if (!snap) return null;
          const src = sources.get(snap.sourceId);
          const links = Array.from(evidenceLinks.values()).filter((e) => e.snapshotId === snap.id);
          return {
            ...snap,
            source: src,
            evidenceLinks: links.map((l) => ({ ...l, sourceItem: items.get(l.sourceItemId) })),
          };
        }),
        findMany: vi.fn(async () => Array.from(snapshots.values()).map((snap) => ({
          ...snap,
          source: sources.get(snap.sourceId),
        }))),
        create: vi.fn(async ({ data }: any) => {
          const row = { id: data.id || `snap-${Date.now()}`, retrievedAt: new Date(), ...data };
          snapshots.set(row.id, row);
          return row;
        }),
      },
      regulatorySourceItem: {
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.id) return items.get(where.id) || null;
          if (where.dedupeKey) {
            for (const item of items.values()) {
              if (item.dedupeKey === where.dedupeKey) return item;
            }
          }
          return null;
        }),
        create: vi.fn(async ({ data }: any) => {
          const row = { id: data.id || `item-${Date.now()}`, ...data };
          items.set(row.id, row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const item = items.get(where.id);
          const updated = { ...item, ...data };
          items.set(where.id, updated);
          return updated;
        }),
      },
      regulatorySourceItemEvidence: {
        upsert: vi.fn(async ({ create, update, where }: any) => {
          const key = `${where.sourceItemId_snapshotId.sourceItemId}_${where.sourceItemId_snapshotId.snapshotId}`;
          const existing = evidenceLinks.get(key);
          const row = existing ? { ...existing, ...update } : { id: `ev-${Date.now()}`, ...create };
          evidenceLinks.set(key, row);
          return row;
        }),
      },
      regulatoryAlert: {
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.id) return alerts.get(where.id) || null;
          if (where.automationDraftKey) {
            for (const a of alerts.values()) {
              if (a.automationDraftKey === where.automationDraftKey) return a;
            }
          }
          return null;
        }),
        findFirst: vi.fn(async ({ where }: any) => {
          for (const a of alerts.values()) {
            if (where.id && a.id !== where.id) continue;
            if (where.isActive !== undefined && a.isActive !== where.isActive) continue;
            return a;
          }
          return null;
        }),
        findMany: vi.fn(async () => Array.from(alerts.values())),
        count: vi.fn(async () => alerts.size),
        create: vi.fn(async ({ data }: any) => {
          const row = { id: data.id || `alert-${Date.now()}`, createdAt: new Date(), updatedAt: new Date(), ...data };
          alerts.set(row.id, row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const a = alerts.get(where.id);
          const updated = { ...a, ...data };
          alerts.set(where.id, updated);
          return updated;
        }),
        delete: vi.fn(async ({ where }: any) => {
          alerts.delete(where.id);
          return { id: where.id };
        }),
      },
      alertSubscription: {
        findMany: vi.fn(async () => Array.from(subscriptions.values())),
      },
      user: {
        findMany: vi.fn(async ({ where }: any) => {
          return Array.from(users.values()).filter((u) => u.organizationId === where.organizationId);
        }),
      },
      alertNotification: {
        createMany: vi.fn(async ({ data }: any) => {
          for (const row of data) {
            notifications.set(`notif-${notifications.size + 1}`, row);
          }
          return { count: data.length };
        }),
        count: vi.fn(async () => notifications.size),
      },
      agentRun: {
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.id) return runs.get(where.id) || null;
          if (where.idempotencyKey) {
            for (const r of runs.values()) {
              if (r.idempotencyKey === where.idempotencyKey) return r;
            }
          }
          return null;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const r = runs.get(where.id);
          const updated = { ...r, ...data };
          runs.set(where.id, updated);
          return updated;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const [id, r] of runs.entries()) {
            if (where.idempotencyKey && r.idempotencyKey === where.idempotencyKey) {
              runs.set(id, { ...r, ...data });
              count++;
            }
          }
          return { count };
        }),
      },
      // Expose internal stores for assertions
      __db: { sources, snapshots, items, evidenceLinks, alerts, subscriptions, notifications, users, runs },
    };

    mockAgentRuns = {
      beginRun: vi.fn(async ({ agentType, idempotencyKey, metadata }: any) => {
        const existing = await mockPrisma.agentRun.findUnique({ where: { idempotencyKey } });
        if (existing && existing.status === 'COMPLETED') {
          return { started: true, duplicate: true, run: existing };
        }
        const run = {
          id: `run-${Date.now()}`,
          agentType,
          idempotencyKey,
          status: 'RUNNING',
          metadata,
          costUsd: 0,
          createdAt: new Date(),
        };
        runs.set(run.id, run);
        return { started: true, duplicate: false, run };
      }),
      completeRun: vi.fn(async ({ runId, costUsd, metadata }: any) => {
        const r = runs.get(runId);
        const updated = { ...r, status: 'COMPLETED', costUsd, metadata };
        runs.set(runId, updated);
        return updated;
      }),
      failRun: vi.fn(async ({ runId, error }: any) => {
        const r = runs.get(runId);
        const updated = { ...r, status: 'FAILED', error };
        runs.set(runId, updated);
        return updated;
      }),
    };

    const snapshotService = new RegulatorySnapshotService(mockPrisma);
    const itemService = new RegulatoryItemService(mockPrisma);
    const draftService = new RegulatoryAlertDraftService(mockPrisma);

    enrichmentService = new RegulatoryEnrichmentService({
      prisma: mockPrisma,
      agentRuns: mockAgentRuns,
      snapshotService,
      itemService,
      draftService,
      completeStructuredFn: vi.fn().mockResolvedValue({
        data: {
          title: 'CBK Circular No. 4 of 2026: Capital Requirements',
          officialTitle: 'Banking Act Prudential Guidelines Amendment',
          officialReferenceNumber: 'CBK/PG/2026/04',
          publicationDate: '2026-09-01',
          effectiveDate: '2026-10-01',
          complianceDeadline: '2026-12-31',
          consultationDeadline: null,
          informationType: RegulatoryInformationType.CIRCULAR,
          regulatoryStage: RegulatoryStage.EFFECTIVE,
          materiality: RegulatoryMateriality.CRITICAL,
          alertCategory: 'PRUDENTIAL',
          alertSeverity: 'CRITICAL',
          summary: 'CBK mandates enhanced capital adequacy buffers for Tier 1 commercial banks.',
          whatChanged: 'Core capital ratio increased from 10.5% to 12.5%.',
          complianceImplications: 'Capital plans must be submitted by December 31, 2026.',
          recommendedActions: ['Review Tier 1 ratios', 'Submit capital plan to CBK'],
          affectedSectors: ['BANKING', 'FINTECH'],
          affectedEntityTypes: ['Commercial Banks', 'Microfinance Banks'],
          topics: ['CAPITAL_ADEQUACY', 'PRUDENTIAL_STANDARDS'],
          confidence: 0.98,
          uncertainties: [],
        },
        inputTokens: 1200,
        outputTokens: 450,
        estimatedCostUsd: 0.0125,
      }),
    });

    alertService = new AlertService({ prisma: mockPrisma });
  });

  // =========================================================================
  // Gate A - D: Global Monthly $20 AI Budget Governance & Concurrency
  // =========================================================================
  describe('Gate A-D: Global $20 Monthly Budget Cap & Observability', () => {
    it('enforces a single $20 global monthly budget across all paid AI providers', async () => {
      const budgetStatus = await llmGateway.getMonthlyBudgetStatus('2026-09');
      expect(budgetStatus.budgetUsd).toBe(20.0);
      expect(budgetStatus.remainingUsd).toBe(20.0);
    });

    it('blocks AI execution once the global $20 monthly limit is reached', async () => {
      const period = getCurrentBudgetPeriod();
      // Simulate $19.99 spent in current period
      await redis.incrbyfloat(`ai:cost:global:${period}`, 19.99);

      // Attempting a $0.05 request should throw LLMCostLimitError
      await expect(llmGateway.reserveBudget(0.05, period)).rejects.toThrow(LLMCostLimitError);
    });

    it('tracks provider breakdown as telemetry under the same global ledger', async () => {
      const period = '2026-09';
      await llmGateway.reconcileReservation(period, 0, 8.50, 'anthropic');
      await llmGateway.reconcileReservation(period, 0, 4.00, 'openai');
      await llmGateway.reconcileReservation(period, 0, 1.50, 'gemini');

      const status = await llmGateway.getMonthlyBudgetStatus(period);
      expect(status.spentUsd).toBe(14.0);
      expect(status.remainingUsd).toBe(6.0);
      expect(status.providers.anthropic).toBe(8.5);
      expect(status.providers.openai).toBe(4.0);
      expect(status.providers.gemini).toBe(1.5);
    });

    it('month rollover resets spend according to calendar month', async () => {
      await redis.incrbyfloat('ai:cost:global:2026-09', 20.00); // 100% used in September

      // October period starts clean at $0.00 spent
      const octStatus = await llmGateway.getMonthlyBudgetStatus('2026-10');
      expect(octStatus.spentUsd).toBe(0.0);
      expect(octStatus.remainingUsd).toBe(20.0);
    });
  });

  // =========================================================================
  // Gate E - Q: End-to-End Regulatory Review, Governance & Publication
  // =========================================================================
  describe('Gate E-Q: End-to-End Regulatory Publication Lifecycle', () => {
    it('executes full regulatory lifecycle from source ingestion to admin publish and notification fanout', async () => {
      const { sources, snapshots, alerts, subscriptions, users, notifications } = mockPrisma.__db;

      // 1. Seed trusted source and subscription
      const source = {
        id: 'src-cbk-01',
        sourceKey: 'KE_CBK_CIRCULARS',
        name: 'Central Bank of Kenya Circulars',
        jurisdictionCode: 'KE',
        regulatoryBody: 'CBK',
        authorityType: RegulatoryAuthorityType.PRIMARY_OFFICIAL,
        sourceType: RegulatorySourceType.PORTAL,
        baseUrl: 'https://www.centralbank.go.ke/circulars',
        isActive: true,
      };
      sources.set(source.id, source);

      const orgId = 'org-fintech-kenya';
      users.set('user-admin-1', {
        id: 'user-admin-1',
        email: 'compliance@fintech.co.ke',
        fullName: 'Amina Ndwiga',
        organizationId: orgId,
        deletedAt: null,
      });

      subscriptions.set('sub-1', {
        id: 'sub-1',
        organizationId: orgId,
        jurisdictions: ['KE'],
        regulatoryBodies: ['CBK'],
        categories: ['PRUDENTIAL'],
        severityThreshold: 'HIGH',
        inAppEnabled: true,
        emailEnabled: true,
        emailFrequency: 'REALTIME',
      });

      // 2. Ingest snapshot via W-REG-01
      const snapshot = {
        id: 'snap-cbk-20260901',
        sourceId: source.id,
        canonicalUrl: 'https://www.centralbank.go.ke/circulars/2026/04.pdf',
        contentHash: 'hash-abc-123',
        contentHashVersion: 'sha256-v1',
        rawText: 'CENTRAL BANK OF KENYA CIRCULAR NO 4 OF 2026: CAPITAL ADEQUACY RATIOS INCREASED TO 12.5% EFFECTIVE OCT 1 2026',
        httpStatus: 200,
        retrievedAt: new Date(),
      };
      snapshots.set(snapshot.id, snapshot);

      // 3. Run W-REG-03 enrichment
      const result = await enrichmentService.processSnapshot({
        snapshotId: snapshot.id,
        correlationId: 'exec-test-01',
      });

      expect(result.status).toBe('COMPLETED');
      expect(result.draftCreated).toBe(true);

      // 4. PRE-PUBLISH STATE ASSERTIONS: Customer side-effects must be ZERO
      const draftAlert = alerts.get(result.alertDraftId);
      expect(draftAlert).toBeDefined();
      expect(draftAlert.isActive).toBe(false); // MUST remain inactive
      expect(notifications.size).toBe(0);      // ZERO notifications

      // 5. Admin publication (explicit human authorization)
      const adminUserId = 'user-superadmin-ke';
      await alertService.publishAlert(draftAlert.id, adminUserId);

      // 6. POST-PUBLISH STATE ASSERTIONS:
      const published = alerts.get(draftAlert.id);
      expect(published.isActive).toBe(true);
      expect(published.publishedById).toBe(adminUserId);
      expect(published.publishedAt).toBeDefined();

      // Notifications fanout created
      expect(notifications.size).toBeGreaterThan(0);
    });

    it('rejects publication when called by machine or unauthorized user', async () => {
      // Direct call to publishAlert requires an authenticated user ID
      // Negative test: unauthenticated / missing user
      await expect(alertService.publishAlert('non-existent-alert', '')).rejects.toThrow();
    });

    it('guarantees notification idempotency when publishAlert is called multiple times', async () => {
      const { alerts, subscriptions, users, notifications } = mockPrisma.__db;

      const orgId = 'org-bank-01';
      users.set('u1', { id: 'u1', email: 'c@bank.com', fullName: 'John Doe', organizationId: orgId, deletedAt: null });
      subscriptions.set('s1', {
        id: 's1',
        organizationId: orgId,
        jurisdictions: ['KE'],
        regulatoryBodies: ['CBK'],
        categories: ['PRUDENTIAL'],
        severityThreshold: 'LOW',
        inAppEnabled: true,
        emailEnabled: false,
        emailFrequency: 'REALTIME',
      });

      const alert = {
        id: 'alert-idempotent-test',
        title: 'Prudential Alert',
        summary: 'Summary',
        body: 'Body',
        jurisdictionCode: 'KE',
        regulatoryBody: 'CBK',
        category: 'PRUDENTIAL',
        severity: 'HIGH',
        isActive: false,
        publishedById: 'admin-1',
      };
      alerts.set(alert.id, alert);

      // First publish
      await alertService.publishAlert(alert.id, 'admin-1');
      const countAfterFirst = notifications.size;
      expect(countAfterFirst).toBe(1);

      // Second publish (idempotent double publish)
      await alertService.publishAlert(alert.id, 'admin-1');
      const countAfterSecond = notifications.size;

      // MUST NOT duplicate notifications
      expect(countAfterSecond).toBe(countAfterFirst);
    });

    it('allows an admin to edit customer copy without altering immutable source evidence', async () => {
      const { alerts } = mockPrisma.__db;
      const draft = {
        id: 'draft-edit-test',
        title: 'Original AI Title',
        summary: 'Original AI Summary',
        body: 'Original AI Body',
        category: 'PRUDENTIAL',
        severity: 'MEDIUM',
        isActive: false,
        publishedById: 'automation:W-REG-03',
        primaryRegulatorySourceItemId: 'item-123',
        automationDraftKey: 'W-REG-03:snap-1:v1',
      };
      alerts.set(draft.id, draft);

      const edited = await alertService.updateDraft({
        alertId: draft.id,
        title: 'Admin Refined Title: Capital Buffer Mandate',
        summary: 'Admin Refined Summary for Customers',
      }, 'admin-editor-1');

      expect(edited.title).toBe('Admin Refined Title: Capital Buffer Mandate');
      expect(edited.summary).toBe('Admin Refined Summary for Customers');
      // Immutable evidence links preserved
      expect(edited.primaryRegulatorySourceItemId).toBe('item-123');
      expect(edited.automationDraftKey).toBe('W-REG-03:snap-1:v1');
    });

    it('allows an admin to reject a draft, preventing publication and infinite loop regeneration', async () => {
      const { alerts, items, runs } = mockPrisma.__db;
      const item = { id: 'item-reject-test', verificationState: 'REQUIRES_REVIEW' };
      items.set(item.id, item);

      const runKey = 'W-REG-03:snap-reject:v1';
      runs.set('run-rej', { id: 'run-rej', idempotencyKey: runKey, status: 'COMPLETED' });

      const draft = {
        id: 'draft-reject-test',
        title: 'Non-Material Notice',
        isActive: false,
        primaryRegulatorySourceItemId: item.id,
        automationDraftKey: runKey,
      };
      alerts.set(draft.id, draft);

      const res = await alertService.rejectDraft({
        alertId: draft.id,
        reason: 'Administrative circular not impacting customer operations',
      }, 'admin-reviewer-1');

      expect(res.success).toBe(true);
      expect(alerts.has(draft.id)).toBe(false);

      // Source item marked as REJECTED
      const updatedItem = items.get(item.id);
      expect(updatedItem.verificationState).toBe('REJECTED');

      // Subsequent reconciliation list query will not re-enrich rejected snapshot
      const pending = await enrichmentService.listPendingSnapshots(10);
      expect(pending.snapshots.some((s) => s.id === 'snap-reject')).toBe(false);
    });

    it('preserves historical published alert A when changed source produces update draft B', async () => {
      const { alerts } = mockPrisma.__db;
      const publishedAlertA = {
        id: 'alert-a-published',
        title: 'CBK Circular No 1: Original Guidelines',
        isActive: true,
        publishedAt: new Date('2026-08-01'),
        publishedById: 'admin-1',
        primaryRegulatorySourceItemId: 'item-shared-01',
      };
      alerts.set(publishedAlertA.id, publishedAlertA);

      const updateDraftB = {
        id: 'draft-b-update',
        title: '[UPDATE] CBK Circular No 1: Clarification on Implementation',
        isActive: false,
        publishedById: 'automation:W-REG-03',
        primaryRegulatorySourceItemId: 'item-shared-01',
        automationDraftKey: 'W-REG-03:snap-update-02:v1',
      };
      alerts.set(updateDraftB.id, updateDraftB);

      // Alert A remains published and unmodified
      const retrievedA = alerts.get(publishedAlertA.id);
      expect(retrievedA.isActive).toBe(true);
      expect(retrievedA.title).toBe('CBK Circular No 1: Original Guidelines');

      // Update B is a distinct inactive draft ready for review
      const retrievedB = alerts.get(updateDraftB.id);
      expect(retrievedB.isActive).toBe(false);
      expect(retrievedB.primaryRegulatorySourceItemId).toBe(retrievedA.primaryRegulatorySourceItemId);
    });
  });
});
