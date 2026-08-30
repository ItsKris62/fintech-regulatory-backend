export const JURISDICTION_CODES = ['KE', 'RW', 'MW', 'NG'] as const;

export type JurisdictionCode = typeof JURISDICTION_CODES[number];

export type QueryMode = 'SINGLE' | 'COMPARE';

export type JurisdictionAvailabilityStatus = 'ACTIVE' | 'COMING_SOON' | 'DISABLED';

export interface JurisdictionCapability {
  code: JurisdictionCode;
  label: string;
  queryEnabled: boolean;
  comparisonEnabled: boolean;
  corpusReady: boolean;
  gapAnalysisEnabled: boolean;
  checklistEnabled: boolean;
  customFrameworkEnabled: boolean;
  status: JurisdictionAvailabilityStatus;
}

export const COMPARE_MODE_ENABLED = process.env.COMPARE_MODE_ENABLED === 'true';

export const JURISDICTION_CAPABILITIES: Record<JurisdictionCode, JurisdictionCapability> = {
  KE: {
    code: 'KE',
    label: 'Kenya',
    queryEnabled: true,
    comparisonEnabled: COMPARE_MODE_ENABLED,
    corpusReady: true,
    gapAnalysisEnabled: true,
    checklistEnabled: true,
    customFrameworkEnabled: true,
    status: 'ACTIVE',
  },
  RW: {
    code: 'RW',
    label: 'Rwanda',
    queryEnabled: true,
    comparisonEnabled: COMPARE_MODE_ENABLED,
    corpusReady: true,
    gapAnalysisEnabled: true,
    checklistEnabled: true,
    customFrameworkEnabled: true,
    status: 'ACTIVE',
  },
  MW: {
    code: 'MW',
    label: 'Malawi',
    queryEnabled: true,
    comparisonEnabled: COMPARE_MODE_ENABLED,
    corpusReady: true,
    gapAnalysisEnabled: true,
    checklistEnabled: true,
    customFrameworkEnabled: true,
    status: 'ACTIVE',
  },
  NG: {
    code: 'NG',
    label: 'Nigeria',
    queryEnabled: true,
    comparisonEnabled: false,
    corpusReady: true,
    gapAnalysisEnabled: true,
    checklistEnabled: true,
    customFrameworkEnabled: true,
    status: 'ACTIVE',
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

export type JurisdictionSource = 'REQUEST' | 'LEGACY_DEFAULT' | 'PERSISTED_QUERY' | 'ORGANIZATION_HOME';

export interface SingleJurisdictionContext {
  mode: 'SINGLE';
  jurisdictions: readonly [JurisdictionCode];
  primaryJurisdiction: JurisdictionCode;
  jurisdictionSource: JurisdictionSource;
}

export interface CompareJurisdictionContext {
  mode: 'COMPARE';
  jurisdictions: readonly JurisdictionCode[];
  jurisdictionSource: JurisdictionSource;
}

export type JurisdictionContext = SingleJurisdictionContext | CompareJurisdictionContext;

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
      | 'COMPARE_MODE_DISABLED'
      | 'COMPARISON_NOT_ENABLED'
      | 'COMPARISON_MIN_JURISDICTIONS'
      | 'COMPARISON_MAX_JURISDICTIONS'
      | 'COMPARISON_DUPLICATE_JURISDICTION',
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

  if (!mode || (mode !== 'SINGLE' && mode !== 'COMPARE')) {
    throw new JurisdictionContractError('JURISDICTION_UNSUPPORTED', 'Unsupported Compliance Query mode.');
  }

  if (mode === 'COMPARE') {
    if (!COMPARE_MODE_ENABLED) {
      throw new JurisdictionContractError('COMPARE_MODE_DISABLED', 'COMPARE_MODE_DISABLED');
    }

    if (jurisdictions.length < 2) {
      throw new JurisdictionContractError('COMPARISON_MIN_JURISDICTIONS', 'Compare mode requires at least 2 jurisdictions.');
    }
    if (jurisdictions.length > 4) {
      throw new JurisdictionContractError('COMPARISON_MAX_JURISDICTIONS', 'Compare mode supports a maximum of 4 jurisdictions.');
    }
    
    const uniqueJurisdictions = new Set(jurisdictions);
    if (uniqueJurisdictions.size !== jurisdictions.length) {
      throw new JurisdictionContractError('COMPARISON_DUPLICATE_JURISDICTION', 'Duplicate jurisdictions are not allowed in compare mode.');
    }
    
    const sortedJurisdictions = [...jurisdictions].sort((a, b) => {
      return JURISDICTION_CODES.indexOf(a as JurisdictionCode) - JURISDICTION_CODES.indexOf(b as JurisdictionCode);
    });

    for (const j of sortedJurisdictions) {
      if (!isJurisdictionCode(j)) {
        throw new JurisdictionContractError('JURISDICTION_UNSUPPORTED', 'Unsupported jurisdiction.');
      }
      const capability = JURISDICTION_CAPABILITIES[j];
      if (!capability.comparisonEnabled) {
        throw new JurisdictionContractError(
          'COMPARISON_NOT_ENABLED',
          `${capability.label} does not support comparison mode yet.`,
        );
      }
    }

    return {
      mode: 'COMPARE',
      jurisdictions: sortedJurisdictions as JurisdictionCode[],
      jurisdictionSource: options.source ?? 'REQUEST',
    };
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
  mode: QueryMode;
  jurisdictions: JurisdictionCode[];
  primaryJurisdiction: JurisdictionCode | null;
  jurisdictionSource: JurisdictionSource;
} {
  return {
    mode: context.mode,
    jurisdictions: [...context.jurisdictions],
    primaryJurisdiction: context.mode === 'SINGLE' ? context.primaryJurisdiction : null,
    jurisdictionSource: context.jurisdictionSource,
  };
}
