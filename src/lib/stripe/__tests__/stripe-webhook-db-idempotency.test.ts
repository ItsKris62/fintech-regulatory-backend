import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { stripeWebhookService } from '../webhook.service';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { getStripeClient } from '../client';

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

const mockDbStore = new Map<string, any>();

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    stripeWebhookEvent: {
      findUnique: vi.fn(async ({ where }: { where: { eventId: string } }) => {
        return mockDbStore.get(where.eventId) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: any }) => {
        mockDbStore.set(data.eventId, { ...data, createdAt: new Date() });
        return mockDbStore.get(data.eventId);
      }),
      update: vi.fn(async ({ where, data }: { where: { eventId: string }; data: any }) => {
        const existing = mockDbStore.get(where.eventId) ?? {};
        const updated = { ...existing, ...data };
        mockDbStore.set(where.eventId, updated);
        return updated;
      }),
    },
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
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
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

describe('Stripe Webhook DB Table Idempotency Migration (Phase 2 Deferred)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbStore.clear();
  });

  it('records event in stripeWebhookEvent DB table and rejects duplicate event delivery via DB', async () => {
    const eventId = 'evt_test_db_idempotency_123';

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
          items: { data: [] },
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

    (prisma.organization.update as any).mockResolvedValue({
      id: 'org_123',
      subscriptionStatus: 'ACTIVE',
    });

    const payload = Buffer.from(JSON.stringify(mockEvent));
    const signature = 't=123,v1=test_sig';

    // 1. Initial processing: should persist in DB table and succeed
    await stripeWebhookService.handleEvent(payload, signature);

    expect(prisma.stripeWebhookEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventId,
        eventType: 'customer.subscription.updated',
        status: 'PROCESSING',
      }),
    });

    expect(prisma.stripeWebhookEvent.update).toHaveBeenCalledWith({
      where: { eventId },
      data: expect.objectContaining({
        status: 'PROCESSED',
        processedAt: expect.any(Date),
      }),
    });

    expect(prisma.organization.update).toHaveBeenCalledTimes(1);

    // 2. Duplicate redelivery: should be caught by DB lookup and skipped
    await stripeWebhookService.handleEvent(payload, signature);

    // Organization update must NOT be called a second time
    expect(prisma.organization.update).toHaveBeenCalledTimes(1);
  });
});
