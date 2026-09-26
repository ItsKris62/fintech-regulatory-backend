import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getStripeClient } from '@/lib/stripe/client';
import { intaSendService } from '@/modules/intasend/intasend.service';
import { sendEmail } from '@/lib/email/client';
import { MAX_STREAM_DURATION_MS } from '@/routes/compliance-stream.route';

vi.mock('@/config/app.config', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    appConfig: {
      ...actual.appConfig,
      payments: { ...actual.appConfig.payments, stripeEnabled: true },
      stripe: { ...actual.appConfig.stripe, secretKey: actual.appConfig.stripe?.secretKey || 'sk_test_mock_stripe_key' },
      intasend: { ...actual.appConfig.intasend, publishableKey: 'pub_mock', secretKey: 'sec_mock', isTest: true },
    },
  };
});


vi.mock('@/lib/redis/client', () => ({
  redis: {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    lpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue('OK'),
  },
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    complianceQuery: {
      update: vi.fn().mockResolvedValue({}),
    },
    suppressionList: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    criticalEmailAudit: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {},
}));

// Mock Stripe constructor
let stripeInitOptions: any = null;
vi.mock('stripe', () => {
  return {
    default: class MockStripe {
      _options: any;
      constructor(_key: string, options: any) {
        this._options = options;
        stripeInitOptions = options;
      }
    },
  };
});

// Mock intasend-node
let intasendStkDelayMs = 0;
let intasendStatusDelayMs = 0;
vi.mock('intasend-node', () => {
  function MockIntaSend(this: any) {
    this.collection = () => ({
      mpesaStkPush: vi.fn(async () => {
        if (intasendStkDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, intasendStkDelayMs));
        }
        return { invoice_id: 'inv_123', state: 'PENDING' };
      }),
      status: vi.fn(async () => {
        if (intasendStatusDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, intasendStatusDelayMs));
        }
        return { invoice: { state: 'COMPLETE', mpesa_reference: 'MP123', amount: 1000 } };
      }),
    });
  }
  return {
    default: MockIntaSend,
  };
});


// Mock Resend SDK
let resendDelayMs = 0;
vi.mock('resend', () => {
  return {
    Resend: class MockResend {
      emails = {
        send: vi.fn(async () => {
          if (resendDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, resendDelayMs));
          }
          return { data: { id: 'msg_123' }, error: null };
        }),
      };
    },
  };
});


describe('F-08: Outbound Timeouts and SSE Lifetime Enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeInitOptions = null;
    intasendStkDelayMs = 0;
    intasendStatusDelayMs = 0;
    resendDelayMs = 0;
  });

  describe('Stripe SDK Configuration', () => {
    it('initializes Stripe with a 10s timeout and 2 network retries', () => {
      getStripeClient();
      expect(stripeInitOptions).toBeDefined();
      expect(stripeInitOptions.timeout).toBe(10000);
      expect(stripeInitOptions.maxNetworkRetries).toBe(2);
    });
  });

  describe('IntaSend Service Outbound Timeouts', () => {
    it('aborts initiateSTKPush if the call exceeds 10,000ms', async () => {
      vi.useFakeTimers();
      intasendStkDelayMs = 15000;

      const assertion = expect(
        intaSendService.initiateSTKPush({
          phoneNumber: '254712345678',
          amount: 500,
          accountReference: 'REF123',
          narrative: 'Subscription',
        })
      ).rejects.toThrow(/timed out|timeout/i);

      // Advance timers past 10s timeout
      await vi.advanceTimersByTimeAsync(10001);
      await assertion;
      vi.useRealTimers();
    });

    it('aborts getPaymentStatus if the call exceeds 10,000ms', async () => {
      vi.useFakeTimers();
      intasendStatusDelayMs = 15000;

      const assertion = expect(intaSendService.getPaymentStatus('inv_123')).rejects.toThrow(
        /timed out|timeout/i
      );

      // Advance timers past 10s timeout
      await vi.advanceTimersByTimeAsync(10001);
      await assertion;
      vi.useRealTimers();
    });
  });

  describe('Resend Email Client Outbound Timeouts', () => {
    it('aborts sendEmail if Resend hangs longer than 10,000ms', async () => {
      vi.useFakeTimers();
      resendDelayMs = 15000;

      const promise = sendEmail({
        to: 'user@example.com',
        subject: 'Test Outbound Timeout',
        text: 'Checking 10s timeout',
      });

      // Advance timers past 10s
      await vi.advanceTimersByTimeAsync(10001);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timed out|timeout/i);
      vi.useRealTimers();
    });
  });


  describe('SSE Watchdog Constant', () => {
    it('defines a 30-minute max lifetime constant for SSE compliance streaming', () => {
      expect(MAX_STREAM_DURATION_MS).toBe(30 * 60 * 1000);
    });
  });
});
