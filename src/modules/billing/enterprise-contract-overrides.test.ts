import { describe, expect, it } from 'vitest';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import {
  allowedEnterpriseOverrideKeys,
  applyEnterpriseContractOverrides,
  parseEnterpriseOverrideValue,
} from './enterprise-contract-overrides';

describe('enterprise contract entitlement overrides', () => {
  it('keeps override keys on a typed allowlist', () => {
    expect(allowedEnterpriseOverrideKeys).toEqual(expect.arrayContaining([
      'seats.limit',
      'features.customFrameworks',
      'features.policyGeneration',
      'features.licenseManagement',
      'features.complianceCalendar',
      'limits.complianceQueries.month',
      'limits.gapAnalysis.month',
      'support.tier',
    ]));
  });

  it('rejects invalid keys and invalid value shapes', () => {
    expect(() => parseEnterpriseOverrideValue('features.customFrameworks', true)).not.toThrow();
    expect(() => parseEnterpriseOverrideValue('features.customFrameworks', 'true')).toThrow();
    expect(() => parseEnterpriseOverrideValue('seats.limit', 12)).not.toThrow();
    expect(() => parseEnterpriseOverrideValue('seats.limit', 0)).toThrow();
    expect(() => parseEnterpriseOverrideValue('not.allowed', true)).toThrow();
  });

  it('applies active overrides deterministically without mutating plan defaults', () => {
    const base = PLAN_ENTITLEMENTS.STARTUP;
    const resolved = applyEnterpriseContractOverrides(base, [
      {
        id: 'override_custom_frameworks',
        contractId: 'contract_1',
        key: 'features.customFrameworks',
        value: true,
      },
      {
        id: 'override_seats',
        contractId: 'contract_1',
        key: 'seats.limit',
        value: 12,
      },
      {
        id: 'override_queries',
        contractId: 'contract_1',
        key: 'limits.complianceQueries.month',
        value: 500,
      },
    ]);

    expect(resolved.entitlements.customFrameworks).toBe(true);
    expect(resolved.entitlements.maxSeats).toBe(12);
    expect(resolved.entitlements.complianceQueries).toEqual({ limit: 500, period: 'month' });
    expect(resolved.appliedOverrides).toHaveLength(3);
    expect(resolved.appliedOverrides[0]).toMatchObject({
      key: 'features.customFrameworks',
      source: 'enterprise_contract',
      contractId: 'contract_1',
      overrideId: 'override_custom_frameworks',
    });
    expect(PLAN_ENTITLEMENTS.STARTUP.customFrameworks).toBe(false);
    expect(PLAN_ENTITLEMENTS.STARTUP.maxSeats).toBe(1);
  });
});
