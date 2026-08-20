export const AUDITED_JURISDICTIONS = ['KE', 'RW', 'MW'] as const;

export type AuditedJurisdiction = typeof AUDITED_JURISDICTIONS[number];

export const DEFAULT_JURISDICTION: AuditedJurisdiction = 'KE';

export const JURISDICTION_CURRENCIES: Record<AuditedJurisdiction, string> = {
  KE: 'KES',
  RW: 'RWF',
  MW: 'MWK',
};
