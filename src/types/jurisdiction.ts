export const JURISDICTION_CODES = ['KE', 'RW', 'MW', 'NG'] as const;

export type JurisdictionCode = typeof JURISDICTION_CODES[number];

export type QueryMode = 'SINGLE' | 'COMPARE';

export type JurisdictionAvailabilityStatus = 'ACTIVE' | 'COMING_SOON' | 'DISABLED';

export interface JurisdictionCapability {
  code: JurisdictionCode;
  label: string;
  queryEnabled: boolean;
  comparisonEnabled: boolean;
  status: JurisdictionAvailabilityStatus;
}

export const JURISDICTION_CAPABILITIES: Record<JurisdictionCode, JurisdictionCapability> = {
  KE: {
    code: 'KE',
    label: 'Kenya',
    queryEnabled: true,
    comparisonEnabled: false,
    status: 'ACTIVE',
  },
  RW: {
    code: 'RW',
    label: 'Rwanda',
    queryEnabled: true,
    comparisonEnabled: false,
    status: 'ACTIVE',
  },
  MW: {
    code: 'MW',
    label: 'Malawi',
    queryEnabled: true,
    comparisonEnabled: false,
    status: 'ACTIVE',
  },
  NG: {
    code: 'NG',
    label: 'Nigeria',
    queryEnabled: false,
    comparisonEnabled: false,
    status: 'COMING_SOON',
  },
};

export const JURISDICTION_LABEL_BY_CODE: Record<JurisdictionCode, string> = {
  KE: 'Kenya',
  RW: 'Rwanda',
  MW: 'Malawi',
  NG: 'Nigeria',
};

const CODE_BY_NORMALIZED_LABEL: Record<string, JurisdictionCode> = {
  kenya: 'KE',
  ke: 'KE',
  rwanda: 'RW',
  rw: 'RW',
  malawi: 'MW',
  mw: 'MW',
  nigeria: 'NG',
  ng: 'NG',
};

export function isJurisdictionCode(value: unknown): value is JurisdictionCode {
  return typeof value === 'string' && (JURISDICTION_CODES as readonly string[]).includes(value);
}

export function jurisdictionLabel(code: JurisdictionCode): string {
  return JURISDICTION_LABEL_BY_CODE[code];
}

export function jurisdictionCodeFromLabel(value: string | null | undefined): JurisdictionCode | null {
  if (!value) return null;
  return CODE_BY_NORMALIZED_LABEL[value.trim().toLowerCase()] ?? null;
}

export type JurisdictionSource = 'REQUEST' | 'LEGACY_DEFAULT' | 'PERSISTED_QUERY';

export interface SingleJurisdictionContext {
  mode: 'SINGLE';
  jurisdictions: readonly [JurisdictionCode];
  primaryJurisdiction: JurisdictionCode;
  jurisdictionSource: JurisdictionSource;
}

export type JurisdictionContext = SingleJurisdictionContext;

export interface JurisdictionContractInput {
  mode?: QueryMode;
  jurisdictions?: readonly JurisdictionCode[];
}

export class JurisdictionContractError extends Error {
  constructor(
    public readonly code:
      | 'JURISDICTION_REQUIRED'
      | 'JURISDICTION_UNSUPPORTED'
      | 'JURISDICTION_NOT_AVAILABLE'
      | 'COMPARISON_NOT_ENABLED',
    message: string,
  ) {
    super(message);
    this.name = 'JurisdictionContractError';
  }
}

export function resolveJurisdictionContext(
  input: JurisdictionContractInput,
  options: { allowLegacyDefault?: boolean; source?: JurisdictionSource } = {},
): JurisdictionContext {
  const mode = input.mode;
  const jurisdictions = input.jurisdictions ?? [];

  if (!mode && jurisdictions.length === 0 && options.allowLegacyDefault) {
    return {
      mode: 'SINGLE',
      jurisdictions: ['KE'],
      primaryJurisdiction: 'KE',
      jurisdictionSource: options.source ?? 'LEGACY_DEFAULT',
    };
  }

  if (mode === 'COMPARE') {
    throw new JurisdictionContractError(
      'COMPARISON_NOT_ENABLED',
      'Comparison mode is not enabled for Compliance Query yet.',
    );
  }

  if (mode && mode !== 'SINGLE') {
    throw new JurisdictionContractError('JURISDICTION_UNSUPPORTED', 'Unsupported Compliance Query mode.');
  }

  if (jurisdictions.length !== 1) {
    throw new JurisdictionContractError(
      'JURISDICTION_REQUIRED',
      'Compliance Query requires exactly one enabled jurisdiction.',
    );
  }

  const [primaryJurisdiction] = jurisdictions;
  if (!isJurisdictionCode(primaryJurisdiction)) {
    throw new JurisdictionContractError('JURISDICTION_UNSUPPORTED', 'Unsupported jurisdiction.');
  }

  const capability = JURISDICTION_CAPABILITIES[primaryJurisdiction];
  if (!capability.queryEnabled) {
    throw new JurisdictionContractError(
      'JURISDICTION_NOT_AVAILABLE',
      `${capability.label} is not available for Compliance Query yet.`,
    );
  }

  return {
    mode: 'SINGLE',
    jurisdictions: [primaryJurisdiction],
    primaryJurisdiction,
    jurisdictionSource: options.source ?? 'REQUEST',
  };
}

export function resolvePersistedJurisdictionContext(input: {
  mode?: string | null;
  jurisdictions?: unknown;
  primaryJurisdiction?: string | null;
  metadata?: unknown;
}): JurisdictionContext {
  const metadata = input.metadata && typeof input.metadata === 'object'
    ? input.metadata as Record<string, unknown>
    : {};

  const persistedMode = input.mode ?? (typeof metadata.mode === 'string' ? metadata.mode : undefined);
  const persistedPrimary =
    input.primaryJurisdiction ??
    (typeof metadata.primaryJurisdiction === 'string' ? metadata.primaryJurisdiction : undefined);
  const persistedJurisdictions =
    Array.isArray(input.jurisdictions) ? input.jurisdictions :
    Array.isArray(metadata.jurisdictions) ? metadata.jurisdictions :
    persistedPrimary ? [persistedPrimary] :
    [];

  const jurisdictionCodes = persistedJurisdictions.filter(isJurisdictionCode);

  return resolveJurisdictionContext(
    {
      mode: persistedMode === 'SINGLE' || persistedMode === 'COMPARE' ? persistedMode : undefined,
      jurisdictions: jurisdictionCodes,
    },
    {
      allowLegacyDefault: true,
      source: jurisdictionCodes.length > 0 ? 'PERSISTED_QUERY' : 'LEGACY_DEFAULT',
    },
  );
}

export function serializeJurisdictionContext(context: JurisdictionContext): {
  mode: 'SINGLE';
  jurisdictions: JurisdictionCode[];
  primaryJurisdiction: JurisdictionCode;
  jurisdictionSource: JurisdictionSource;
} {
  return {
    mode: context.mode,
    jurisdictions: [...context.jurisdictions],
    primaryJurisdiction: context.primaryJurisdiction,
    jurisdictionSource: context.jurisdictionSource,
  };
}
