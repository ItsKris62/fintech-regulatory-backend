import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { stripeWebhookService } from '../webhook.service';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { getStripeClient } from '../client';

// Simulated in-memory redis store
const redisStore = new Map<string, string>();

vi.mock('@/config/app.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/app.config')>();
  return {
    ...actual,
    appConfig: {
      ...actual.appConfig,
      frontendUrl: 'https://app.sheriabot.test',
      stripe: {
        ...actual.appConfig.stripe,
        webhookSecret: 'whsec_test_secret',
      },
    },
  };
});

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    organization: {
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    systemConfig: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, opts?: any) => {
      if (opts?.nx && redisStore.has(key)) {
        return null; // key exists, SET NX fails
      }
      redisStore.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      redisStore.delete(key);
      return 1;
    }),
  },
}));

vi.mock('../client', () => ({
  getStripeClient: vi.fn(),
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/email/react-mailer.service', () => ({
  reactMailer: {
    sendPlanActivatedEmail: vi.fn(),
    sendSubscriptionCancelledEmail: vi.fn(),
    sendPaymentFailedEmail: vi.fn(),
    sendTrialEndingReminderEmail: vi.fn(),
  },
}));

vi.mock('@/modules/billing/payment.service', () => ({
  paymentService: {
    generateInvoiceNumber: vi.fn().mockResolvedValue('INV-001'),
    createPaymentRecord: vi.fn().mockResolvedValue({}),
  },
}));

describe('F-06: Stripe Webhook Idempotency Lock Lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStore.clear();
  });

  it('releases idempotency key on DB failure so redelivery succeeds (F-06)', async () => {
    const eventId = 'evt_test_db_failure_123';
    const redisKey = `sheriabot:stripe:evt:${eventId}`;

    const mockEvent: Stripe.Event = {
      id: eventId,
      object: 'event',
      api_version: '2023-10-16',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'sub_123',
          customer: 'cus_123',
          status: 'active',
          items: {
            data: [],
          },
        } as unknown as Stripe.Subscription,
      },
      livemode: false,
      pending_webhooks: 0,
      request: null,
      type: 'customer.subscription.updated',
    };

    (getStripeClient as any).mockReturnValue({
      webhooks: {
        constructEvent: vi.fn().mockReturnValue(mockEvent),
      },
      subscriptions: {
        retrieve: vi.fn(),
      },
    });

    (prisma.organization.findUnique as any).mockResolvedValue({
      id: 'org_123',
      name: 'Test Org',
      plan: 'STARTUP',
      subscriptionStatus: 'ACTIVE',
    });

    // 1. FIRST ATTEMPT: Simulate DB failure mid-handler
    (prisma.organization.update as any).mockRejectedValueOnce(
      new Error('Prisma database connection pool timeout')
    );

    const payload = Buffer.from(JSON.stringify(mockEvent));
    const signature = 't=123,v1=test_sig';

    await expect(
      stripeWebhookService.handleEvent(payload, signature)
    ).rejects.toThrow('Prisma database connection pool timeout');

    // Assert the idempotency key was released on failure
    const keyAfterFailure = await redis.get(redisKey);
    expect(keyAfterFailure).toBeNull();

    // 2. REPLAY: Second delivery should process successfully now that DB is recovered
    (prisma.organization.update as any).mockResolvedValueOnce({
      id: 'org_123',
      subscriptionStatus: 'ACTIVE',
    });

    await expect(
      stripeWebhookService.handleEvent(payload, signature)
    ).resolves.not.toThrow();

    expect(prisma.organization.update).toHaveBeenCalledTimes(2);

    // Key should be set after successful processing
    const keyAfterSuccess = await redis.get(redisKey);
    expect(keyAfterSuccess).not.toBeNull();
  });
});
