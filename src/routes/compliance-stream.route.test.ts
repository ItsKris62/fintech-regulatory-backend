import { describe, expect, it, vi, beforeEach } from 'vitest';
import { extractNamedRegulations, checkAndPrepareUsage } from './compliance-stream.route';
import { redis } from '@/lib/redis/client';
import * as trialUsage from '@/modules/trial';

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn(),
    incrby: vi.fn(),
    expire: vi.fn(),
  },
}));

vi.mock('@/modules/trial', () => ({
  checkTrialLimit: vi.fn(),
  incrementTrialUsageAtomic: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {},
}));

describe('Compliance Stream Routing & Billing Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('extractNamedRegulations', () => {
    it('1. extracts a single regulation by name', () => {
      const q = "Does the Data Protection Act apply here?";
      expect(extractNamedRegulations(q)).toEqual(["Data Protection Act"]);
    });

    it('2. extracts multiple named regulations', () => {
      const q = "According to the Data Protection Act and CBK Guidelines 2024, what should we do?";
      expect(extractNamedRegulations(q)).toEqual(["Data Protection Act", "CBK Guidelines 2024"]);
    });

    it('3. handles regulations with years', () => {
      const q = "What does the National Payment System Act 2011 say?";
      expect(extractNamedRegulations(q)).toEqual(["National Payment System Act 2011"]);
    });

    it('4. ignores generic non-capitalized terms', () => {
      const q = "What does the new act say about these regulations?";
      expect(extractNamedRegulations(q)).toEqual([]);
    });
  });

  describe('checkAndPrepareUsage', () => {
    const defaultAuth = {
      userId: 'user1',
      organizationId: 'org1',
      plan: 'STARTUP' as const,
      features: ['complianceQuery'],
      entitlements: {
        complianceQueries: { limit: 500, period: 'monthly' },
      },
    };

    it('5. allows standard query if quota allows (1 credit)', async () => {
      vi.mocked(redis.get).mockResolvedValue(5);
      const result = await checkAndPrepareUsage(defaultAuth as any, 1);
      expect(result.allowed).toBe(true);
      expect(result.statusCode).toBe(429);
    });

    it('6. allows detailed query if quota allows (2 credits)', async () => {
      vi.mocked(redis.get).mockResolvedValue(498);
      const result = await checkAndPrepareUsage(defaultAuth as any, 2);
      expect(result.allowed).toBe(true);
    });

    it('7. rejects detailed query if only 1 credit remaining', async () => {
      vi.mocked(redis.get).mockResolvedValue(499);
      const result = await checkAndPrepareUsage(defaultAuth as any, 2);
      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(429);
      expect(result.message).toContain("Detailed answers require 2 query credits");
    });

    it('8. rejects standard query if 0 credits remaining', async () => {
      vi.mocked(redis.get).mockResolvedValue(500);
      const result = await checkAndPrepareUsage(defaultAuth as any, 1);
      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(429);
      expect(result.message).toContain("Monthly limit reached");
    });

    it('9. returns a deferred increment function that consumes correct credits', async () => {
      vi.mocked(redis.get).mockResolvedValue(5);
      vi.mocked(redis.incrby).mockResolvedValue(7);
      const result = await checkAndPrepareUsage(defaultAuth, 2);
      expect(result.allowed).toBe(true);
      
      await result.increment();
      expect(redis.incrby).toHaveBeenCalledWith(expect.any(String), 2);
    });

    it('10. handles FREE_TRIAL quotas correctly, rejecting if limit reached', async () => {
      const trialAuth = { ...defaultAuth, plan: 'FREE_TRIAL' as const };
      vi.mocked(trialUsage.checkTrialLimit).mockResolvedValueOnce({
        allowed: true,
        current: 19,
        limit: 20,
      }); // Only 1 query left

      const result = await checkAndPrepareUsage(trialAuth, 2);
      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(403);
      expect(result.message).toContain("Detailed answers require 2 query credits");
    });
  });
});
