import { beforeEach, describe, expect, it, vi } from 'vitest';
import { intaSendService, _resetSDK } from '../intasend.service';

const mockMpesaStkPush = vi.fn();
const mockStatus = vi.fn();

vi.mock('@/config/app.config', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    appConfig: {
      ...actual.appConfig,
      intasend: {
        publishableKey: 'pub_mock',
        secretKey: 'sec_mock',
        isTest: true,
      },
    },
  };
});

vi.mock('intasend-node', () => {
  function MockIntaSend(this: any) {
    this.collection = () => ({
      mpesaStkPush: mockMpesaStkPush,
      status: mockStatus,
    });
  }
  return {
    default: MockIntaSend,
  };
});

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('IntaSend Native AbortSignal Support (Phase 2 Deferred)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSDK();
    mockMpesaStkPush.mockReset();
    mockStatus.mockReset();
  });

  it('short-circuits initiateSTKPush immediately when passed an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      intaSendService.initiateSTKPush(
        {
          phoneNumber: '254712345678',
          amount: 100,
          accountReference: 'REF-1',
          narrative: 'Test payment',
        },
        controller.signal
      )
    ).rejects.toThrow(/aborted|abort/i);

    expect(mockMpesaStkPush).not.toHaveBeenCalled();
  });

  it('short-circuits initiateSTKPush when signal is provided in STKPushInput', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      intaSendService.initiateSTKPush({
        phoneNumber: '254712345678',
        amount: 100,
        accountReference: 'REF-1',
        narrative: 'Test payment',
        signal: controller.signal,
      })
    ).rejects.toThrow(/aborted|abort/i);

    expect(mockMpesaStkPush).not.toHaveBeenCalled();
  });

  it('aborts getPaymentStatus in-flight when signal is triggered', async () => {
    const controller = new AbortController();

    mockStatus.mockImplementation(() => {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ invoice: { state: 'COMPLETE' } }), 1000);
      });
    });

    const callPromise = intaSendService.getPaymentStatus('inv_test_signal_123', controller.signal);
    // Abort while in flight
    setTimeout(() => controller.abort(), 10);

    await expect(callPromise).rejects.toThrow(/aborted|abort/i);
  });
});
