export const AUDITED_JURISDICTIONS = ['KE', 'RW', 'MW', 'NG'] as const;

export type AuditedJurisdiction = typeof AUDITED_JURISDICTIONS[number];

export const DEFAULT_JURISDICTION: AuditedJurisdiction = 'KE';

export const JURISDICTION_CURRENCIES: Record<AuditedJurisdiction, string> = {
  KE: 'KES',
  RW: 'RWF',
  MW: 'MWK',
  NG: 'NGN',
};

export interface JurisdictionCapability {
  code: AuditedJurisdiction;
  name: string;
  currency: string;
  isSupported: boolean;
  hasComplianceBaseline: boolean;
  hasRegulatoryAlerts: boolean;
}

export const JURISDICTION_REGISTRY: Record<AuditedJurisdiction, JurisdictionCapability> = {
  KE: {
    code: 'KE',
    name: 'Kenya',
    currency: 'KES',
    isSupported: true,
    hasComplianceBaseline: true,
    hasRegulatoryAlerts: true,
  },
  RW: {
    code: 'RW',
    name: 'Rwanda',
    currency: 'RWF',
    isSupported: true,
    hasComplianceBaseline: false,
    hasRegulatoryAlerts: true,
  },
  MW: {
    code: 'MW',
    name: 'Malawi',
    currency: 'MWK',
    isSupported: true,
    hasComplianceBaseline: false,
    hasRegulatoryAlerts: true,
  },
  NG: {
    code: 'NG',
    name: 'Nigeria',
    currency: 'NGN',
    isSupported: true,
    hasComplianceBaseline: false,
    hasRegulatoryAlerts: true,
  },
};

export function isSupportedJurisdiction(code?: string | null): code is AuditedJurisdiction {
  if (!code) return false;
  return (AUDITED_JURISDICTIONS as readonly string[]).includes(code.toUpperCase());
}

export function hasComplianceBaseline(code?: string | null): boolean {
  if (!code) return false;
  const upper = code.toUpperCase();
  if (!isSupportedJurisdiction(upper)) return false;
  return Boolean(JURISDICTION_REGISTRY[upper]?.hasComplianceBaseline);
}

export function getJurisdictionCapability(code?: string | null): JurisdictionCapability | null {
  if (!code) return null;
  const upper = code.toUpperCase();
  if (!isSupportedJurisdiction(upper)) return null;
  return JURISDICTION_REGISTRY[upper] ?? null;
}
