import { describe, expect, it, vi } from 'vitest';
import { MarketingCampaignStatus, MarketingTemplateKey } from '@prisma/client';
import { AutomationNewsletterService } from './newsletter.service';
import type { AutomationNewsletterServiceDependencies } from './newsletter.service';

type ApprovalServiceStub = NonNullable<AutomationNewsletterServiceDependencies['approvalService']>;
type CampaignServiceStub = NonNullable<AutomationNewsletterServiceDependencies['campaignService']>;
type RedisStub = NonNullable<AutomationNewsletterServiceDependencies['redis']> & {
  store: Map<string, string>;
};

const VALID_METADATA: Record<string, unknown> = {
  listId: 'list_1',
  subject: 'The Kenyan Compliance Brief - Week 30',
  templateVariables: {
    editionLabel: 'Week of 21 July 2026',
    items: [{ title: 'CBK issues new circular', summary: 'Summary text.' }],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function approvalServiceStub(overrides: {
  status?: 'pending' | 'approved' | 'rejected';
  decidedBy?: string | null;
  metadata?: Record<string, unknown>;
} = {}): ApprovalServiceStub {
  const metadata: Record<string, unknown> = overrides.metadata ?? VALID_METADATA;
  return {
    getApproval: vi.fn().mockResolvedValue({
      status: overrides.status ?? 'approved',
      decidedBy: overrides.decidedBy === undefined ? 'admin_user_1' : overrides.decidedBy,
    }),
    requireMetadataField: vi.fn().mockImplementation(async (_approvalId: string, field: string) => {
      const value = metadata[field];
      if (typeof value !== 'string' || value.length === 0) {
        throw Object.assign(new Error(`missing field ${field}`), { code: 'BAD_REQUEST' });
      }
      return value;
    }),
    requireMetadataObjectField: vi.fn().mockImplementation(async (_approvalId: string, field: string) => {
      const value = metadata[field];
      if (!isRecord(value)) {
        throw Object.assign(new Error(`missing object field ${field}`), { code: 'BAD_REQUEST' });
      }
      return value;
    }),
  };
}

function fakeCampaignService(overrides: {
  create?: CampaignServiceStub['create'];
  requestSendConfirmation?: CampaignServiceStub['requestSendConfirmation'];
  executeSend?: CampaignServiceStub['executeSend'];
  getById?: CampaignServiceStub['getById'];
} = {}): CampaignServiceStub {
  return {
    create: overrides.create ?? vi.fn().mockResolvedValue({ id: 'camp_1' }),
    requestSendConfirmation: overrides.requestSendConfirmation ?? vi.fn().mockResolvedValue({
      confirmationToken: 'tok_1',
      recipientCount: 3,
      estimatedDurationSeconds: 6,
      expiresAt: new Date('2026-07-24T00:05:00.000Z'),
      isAsync: false,
    }),
    executeSend: overrides.executeSend ?? vi.fn().mockResolvedValue({
      campaignId: 'camp_1',
      finalStatus: MarketingCampaignStatus.SENT,
      sent: 3,
      skipped: 0,
      failed: 0,
    }),
    getById: overrides.getById ?? vi.fn().mockResolvedValue(null),
  };
}

/** In-memory fake standing in for the Upstash redis client (get/set/del only, per RedisLike). */
function fakeRedis(initial: Record<string, string> = {}): RedisStub {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
    set: vi.fn(async (key: string, value: string, opts?: { ex?: number; nx?: boolean }) => {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),
    store,
  };
}

describe('AutomationNewsletterService.sendNewsletter', () => {
  it('enforces the approval gate before anything else - rejects a non-approved approval', async () => {
    const approvalService = approvalServiceStub({ status: 'pending' });
    const service = new AutomationNewsletterService({ approvalService, campaignService: fakeCampaignService(), redis: fakeRedis() });

    await expect(service.sendNewsletter({ approvalId: 'appr_1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('throws INTERNAL_SERVER_ERROR and never attributes the send to a system principal when decidedBy is missing on an approved approval', async () => {
    const approvalService = approvalServiceStub({ status: 'approved', decidedBy: null });
    const campaignService = fakeCampaignService();
    const service = new AutomationNewsletterService({ approvalService, campaignService, redis: fakeRedis() });

    await expect(service.sendNewsletter({ approvalId: 'appr_1' })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(campaignService.create).not.toHaveBeenCalled();
  });

  it('creates the campaign, bridges confirmation with the approving human as both requestedById and executedById, and returns the send result', async () => {
    const approvalService = approvalServiceStub();
    const campaignService = fakeCampaignService();
    const redis = fakeRedis();
    const service = new AutomationNewsletterService({ approvalService, campaignService, redis });

    const result = await service.sendNewsletter({ approvalId: 'appr_1' });

    expect(campaignService.create).toHaveBeenCalledWith({
      name: expect.stringContaining('Week of 21 July 2026'),
      subject: VALID_METADATA.subject,
      templateKey: MarketingTemplateKey.KENYAN_COMPLIANCE_BRIEF,
      templateVariables: VALID_METADATA.templateVariables,
      listId: VALID_METADATA.listId,
      createdById: 'admin_user_1',
    });

    expect(campaignService.requestSendConfirmation).toHaveBeenCalledWith({
      campaignId: 'camp_1',
      requestedById: 'admin_user_1',
    });
    expect(campaignService.executeSend).toHaveBeenCalledWith({
      campaignId: 'camp_1',
      confirmationToken: 'tok_1',
      confirmedRecipientCount: 3,
      executedById: 'admin_user_1',
    });

    expect(result).toEqual({ campaignId: 'camp_1', finalStatus: MarketingCampaignStatus.SENT, sent: 3, skipped: 0, failed: 0 });

    // Sent marker persisted so a retry replays instead of double-sending.
    expect(redis.store.get('sheriabot:automation:newsletter:sent:appr_1')).toBe('camp_1');
    // In-progress lock released after completion.
    expect(redis.store.has('sheriabot:automation:newsletter:lock:appr_1')).toBe(false);
  });

  it('is idempotent on approvalId - a duplicate call after a completed send replays the existing campaign instead of sending again', async () => {
    const approvalService = approvalServiceStub();
    const campaignService = fakeCampaignService({
      getById: vi.fn().mockResolvedValue({
        id: 'camp_1',
        status: MarketingCampaignStatus.SENT,
        totalSent: 3,
        totalSuppressedSkip: 1,
        totalNoConsentSkip: 0,
        totalFailed: 0,
      }),
    });
    const redis = fakeRedis({ 'sheriabot:automation:newsletter:sent:appr_1': 'camp_1' });
    const service = new AutomationNewsletterService({ approvalService, campaignService, redis });

    const result = await service.sendNewsletter({ approvalId: 'appr_1' });

    expect(campaignService.create).not.toHaveBeenCalled();
    expect(campaignService.requestSendConfirmation).not.toHaveBeenCalled();
    expect(campaignService.executeSend).not.toHaveBeenCalled();
    expect(result).toEqual({ campaignId: 'camp_1', finalStatus: MarketingCampaignStatus.SENT, sent: 3, skipped: 1, failed: 0 });
  });

  it('rejects a concurrent duplicate call with CONFLICT while a send for the same approval is still in progress', async () => {
    const approvalService = approvalServiceStub();
    const campaignService = fakeCampaignService();
    const redis = fakeRedis({ 'sheriabot:automation:newsletter:lock:appr_1': 'admin_user_1' });
    const service = new AutomationNewsletterService({ approvalService, campaignService, redis });

    await expect(service.sendNewsletter({ approvalId: 'appr_1' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(campaignService.create).not.toHaveBeenCalled();
  });

  it('releases the in-progress lock when executeSend throws, so a genuine retry is not permanently blocked', async () => {
    const approvalService = approvalServiceStub();
    const campaignService = fakeCampaignService({
      executeSend: vi.fn().mockRejectedValue(new Error('transient failure')),
    });
    const redis = fakeRedis();
    const service = new AutomationNewsletterService({ approvalService, campaignService, redis });

    await expect(service.sendNewsletter({ approvalId: 'appr_1' })).rejects.toThrow('transient failure');
    expect(redis.store.has('sheriabot:automation:newsletter:lock:appr_1')).toBe(false);
    expect(redis.store.has('sheriabot:automation:newsletter:sent:appr_1')).toBe(false);
  });

  it('rejects with BAD_REQUEST and releases the lock when templateVariables fail the template Zod schema', async () => {
    const approvalService = approvalServiceStub({
      metadata: { ...VALID_METADATA, templateVariables: { editionLabel: '', items: [] } },
    });
    const campaignService = fakeCampaignService();
    const redis = fakeRedis();
    const service = new AutomationNewsletterService({ approvalService, campaignService, redis });

    await expect(service.sendNewsletter({ approvalId: 'appr_1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(campaignService.create).not.toHaveBeenCalled();
    expect(redis.store.has('sheriabot:automation:newsletter:lock:appr_1')).toBe(false);
  });
});
