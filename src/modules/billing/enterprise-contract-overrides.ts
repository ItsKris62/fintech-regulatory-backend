import { z } from 'zod';
import type { PlanEntitlementConfig } from '@/config/entitlements.config';

export const allowedEnterpriseOverrideKeys = [
  'seats.limit',
  'features.customFrameworks',
  'features.policyGeneration',
  'features.licenseManagement',
  'features.complianceCalendar',
  'features.gapAnalysis',
  'features.benchmarkDocuments',
  'limits.complianceQueries.month',
  'limits.gapAnalysis.month',
  'limits.policyGeneration.month',
  'limits.documentUploads.month',
  'limits.storageGb',
  'limits.customFrameworks.count',
  'limits.benchmarkDocuments.count',
  'support.tier',
] as const;

export type EnterpriseOverrideKey = (typeof allowedEnterpriseOverrideKeys)[number];

export interface AppliedEnterpriseOverride {
  key: EnterpriseOverrideKey;
  source: 'enterprise_contract';
  contractId: string;
  overrideId: string;
}

type EnterpriseOverrideRow = {
  id: string;
  contractId: string;
  key: string;
  value: unknown;
};

const positiveIntegerOrUnlimited = z.number().int().refine((value) => value === -1 || value >= 0, {
  message: 'Value must be -1 or a non-negative integer.',
});
const positiveSeatLimit = z.number().int().refine((value) => value === -1 || value >= 1, {
  message: 'Seat limit must be -1 or a positive integer.',
});

export const enterpriseOverrideValueSchemas = {
  'seats.limit': positiveSeatLimit,
  'features.customFrameworks': z.boolean(),
  'features.policyGeneration': z.boolean(),
  'features.licenseManagement': z.boolean(),
  'features.complianceCalendar': z.boolean(),
  'features.gapAnalysis': z.boolean(),
  'features.benchmarkDocuments': z.boolean(),
  'limits.complianceQueries.month': positiveIntegerOrUnlimited,
  'limits.gapAnalysis.month': positiveIntegerOrUnlimited,
  'limits.policyGeneration.month': positiveIntegerOrUnlimited,
  'limits.documentUploads.month': positiveIntegerOrUnlimited,
  'limits.storageGb': positiveIntegerOrUnlimited,
  'limits.customFrameworks.count': positiveIntegerOrUnlimited,
  'limits.benchmarkDocuments.count': positiveIntegerOrUnlimited,
  'support.tier': z.enum(['community', 'email-48hr', 'priority-24hr', 'dedicated']),
} satisfies Record<EnterpriseOverrideKey, z.ZodTypeAny>;

export function isEnterpriseOverrideKey(key: string): key is EnterpriseOverrideKey {
  return (allowedEnterpriseOverrideKeys as readonly string[]).includes(key);
}

export function parseEnterpriseOverrideValue(key: string, value: unknown): unknown {
  if (!isEnterpriseOverrideKey(key)) {
    throw new Error(`Unsupported enterprise override key: ${key}`);
  }
  return enterpriseOverrideValueSchemas[key].parse(value);
}

export function applyEnterpriseContractOverrides(
  base: PlanEntitlementConfig,
  rows: EnterpriseOverrideRow[],
): { entitlements: PlanEntitlementConfig; appliedOverrides: AppliedEnterpriseOverride[] } {
  const entitlements: PlanEntitlementConfig = {
    ...base,
    complianceQueries: { ...base.complianceQueries },
    checklistGenerations: { ...base.checklistGenerations },
    gapAnalysis: { ...base.gapAnalysis },
    documentRepository: { ...base.documentRepository },
    apiAccess: base.apiAccess === false ? false : { ...base.apiAccess },
    alerts: base.alerts ? { ...base.alerts } : undefined,
  };
  const appliedOverrides: AppliedEnterpriseOverride[] = [];

  for (const row of rows) {
    if (!isEnterpriseOverrideKey(row.key)) continue;
    const value = parseEnterpriseOverrideValue(row.key, row.value);

    switch (row.key) {
      case 'seats.limit':
        entitlements.maxSeats = value as number;
        break;
      case 'features.customFrameworks':
        entitlements.customFrameworks = value as boolean;
        break;
      case 'features.policyGeneration':
        entitlements.policyGeneration = value as boolean;
        break;
      case 'features.licenseManagement':
        entitlements.licenseManagement = value as boolean;
        break;
      case 'features.complianceCalendar':
        entitlements.complianceCalendar = value as boolean;
        break;
      case 'features.gapAnalysis':
        entitlements.gapAnalysis = { ...entitlements.gapAnalysis, limit: (value as boolean) ? -1 : 0 };
        break;
      case 'features.benchmarkDocuments':
        entitlements.benchmarkDocuments = value as boolean;
        break;
      case 'limits.complianceQueries.month':
        entitlements.complianceQueries = { limit: value as number, period: 'month' };
        break;
      case 'limits.gapAnalysis.month':
        entitlements.gapAnalysis = { limit: value as number, period: 'month' };
        break;
      case 'limits.policyGeneration.month':
        entitlements.policyGeneration = (value as number) !== 0;
        break;
      case 'limits.documentUploads.month':
        entitlements.documentRepository = { limitMB: value as number };
        break;
      case 'limits.storageGb':
        entitlements.documentRepository = {
          limitMB: (value as number) === -1 ? -1 : (value as number) * 1024,
        };
        break;
      case 'limits.customFrameworks.count':
      case 'limits.benchmarkDocuments.count':
        break;
      case 'support.tier':
        entitlements.supportTier = value as PlanEntitlementConfig['supportTier'];
        break;
    }

    appliedOverrides.push({
      key: row.key,
      source: 'enterprise_contract',
      contractId: row.contractId,
      overrideId: row.id,
    });
  }

  return { entitlements, appliedOverrides };
}
