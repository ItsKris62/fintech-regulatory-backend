import { describe, expect, it } from 'vitest';
import { vaultPresignInputSchema, VAULT_TIER_VALUES } from '../vault.module';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';

describe('vault tier enum validation', () => {
  const baseValidPayload = {
    organizationId: 'org_test_123',
    uploaderId: 'user_test_123',
    documentId: 'c12345678',
    name: 'Compliance Report 2026',
    declaredFilename: 'report.pdf',
    declaredMimeType: 'application/pdf',
    declaredSize: 1024 * 1024,
    category: 'COMPLIANCE' as const,
    tags: ['audit', 'q1'],
  };

  const expectedTiers = [
    'FREE',
    'FREE_TRIAL',
    'STARTER',
    'GROWTH',
    'STARTUP',
    'BUSINESS',
    'ENTERPRISE',
    'REGULATOR',
  ] as const;

  it('accepts each valid tier without validation errors', () => {
    for (const tier of expectedTiers) {
      const result = vaultPresignInputSchema.safeParse({
        ...baseValidPayload,
        tier,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tier).toBe(tier);
      }
    }
  });

  it('rejects an unknown or invalid tier value', () => {
    const result = vaultPresignInputSchema.safeParse({
      ...baseValidPayload,
      tier: 'INVALID_PLAN',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const tierIssue = result.error.issues.find((issue) => issue.path.includes('tier'));
      expect(tierIssue).toBeDefined();
    }
  });

  it('vault tier enum matches EffectivePlan / PLAN_ENTITLEMENTS keys exactly', () => {
    const entitlementPlanKeys = Object.keys(PLAN_ENTITLEMENTS).sort();
    const vaultTierValuesSorted = [...VAULT_TIER_VALUES].sort();

    expect(vaultTierValuesSorted).toEqual(entitlementPlanKeys);
  });
});
