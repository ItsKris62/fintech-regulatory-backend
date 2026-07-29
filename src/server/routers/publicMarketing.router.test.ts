import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publicMarketingRouter } from './publicMarketing.router';

const mocks = vi.hoisted(() => {
  const tx = {
    contact: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    consentRecord: {
      create: vi.fn(),
    },
    contactList: {
      findFirst: vi.fn(),
    },
    contactListMembership: {
      upsert: vi.fn(),
    },
  };

  return {
    redisSet: vi.fn(),
    rateLimitCheckOrThrow: vi.fn(),
    isSuppressed: vi.fn(),
    tx,
    prismaMock: {
      $transaction: vi.fn(async (callback: (txArg: typeof tx) => unknown) => callback(tx)),
      campaignSend: { findFirst: vi.fn(), update: vi.fn() },
      marketingCampaign: { update: vi.fn() },
    },
  };
});

vi.mock('@/lib/redis/client', () => ({
  redis: { set: mocks.redisSet },
}));

vi.mock('@/lib/redis/rate-limiter', () => ({
  rateLimiter: {
    checkOrThrow: mocks.rateLimitCheckOrThrow,
    check: vi.fn().mockResolvedValue({ allowed: true }),
  },
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: mocks.prismaMock,
}));

vi.mock('@/modules/marketing/suppression.service', () => ({
  isSuppressed: mocks.isSuppressed,
  suppress: vi.fn(),
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('publicMarketing.subscribeBlogNewsletter', () => {
  beforeEach(() => {
    process.env.SHERIABOT_BLOG_NEWSLETTER_LIST_ID = 'list_blog';
    mocks.redisSet.mockResolvedValue('OK');
    mocks.rateLimitCheckOrThrow.mockResolvedValue(undefined);
    mocks.isSuppressed.mockResolvedValue(false);
    mocks.tx.contact.findUnique.mockResolvedValue(null);
    mocks.tx.contact.create.mockResolvedValue({ id: 'contact_1' });
    mocks.tx.contact.update.mockResolvedValue({ id: 'contact_1' });
    mocks.tx.consentRecord.create.mockResolvedValue({ id: 'consent_1' });
    mocks.tx.contactList.findFirst.mockResolvedValue({ id: 'list_blog' });
    mocks.tx.contactListMembership.upsert.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.SHERIABOT_BLOG_NEWSLETTER_LIST_ID;
  });

  it('normalises email, records consent, and adds only the configured Blog newsletter list', async () => {
    const caller = publicMarketingRouter.createCaller({ req: { ip: '127.0.0.1' } } as any);

    await expect(caller.subscribeBlogNewsletter({
      email: ' Reader@Example.COM ',
      sourcePage: '/blog',
      readerSessionId: 'session_1',
      privacyPolicyVersion: 'v1',
    })).resolves.toEqual({ success: true });

    expect(mocks.tx.contact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        email: 'reader@example.com',
        consentStatus: 'GRANTED',
        consentSource: 'blog_newsletter_form',
        tags: ['blog-newsletter'],
      }),
      select: { id: true },
    }));
    expect(mocks.tx.consentRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        contactId: 'contact_1',
        action: 'GRANTED',
        source: 'blog_newsletter_form',
        metadata: expect.objectContaining({
          sourcePage: '/blog',
          privacyPolicyVersion: 'v1',
          requestIpHash: expect.stringMatching(/^[a-f0-9]{16}$/),
        }),
      }),
    }));
    expect(mocks.tx.consentRecord.create.mock.calls[0][0].data.ipAddress).toBeUndefined();
    expect(mocks.tx.contactListMembership.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { listId_contactId: { listId: 'list_blog', contactId: 'contact_1' } },
    }));
  });

  it('returns generic success for duplicate email submissions without re-running writes', async () => {
    mocks.redisSet.mockResolvedValue(null);
    const caller = publicMarketingRouter.createCaller({ req: { ip: '127.0.0.1' } } as any);

    await expect(caller.subscribeBlogNewsletter({ email: 'reader@example.com' })).resolves.toEqual({ success: true });

    expect(mocks.prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('returns generic success for suppressed contacts without re-subscribing them', async () => {
    mocks.isSuppressed.mockResolvedValue(true);
    const caller = publicMarketingRouter.createCaller({ req: { ip: '127.0.0.1' } } as any);

    await expect(caller.subscribeBlogNewsletter({ email: 'reader@example.com' })).resolves.toEqual({ success: true });

    expect(mocks.prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
