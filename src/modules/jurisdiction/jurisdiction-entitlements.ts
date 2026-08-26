import { TRPCError } from '@trpc/server';
import type { EffectivePlan } from '@/types/plan.types';
import { logger } from '@/utils/logger';
import {
  JURISDICTION_CAPABILITIES,
  JurisdictionContractError,
  isJurisdictionCode,
  resolveJurisdictionContext,
  type JurisdictionCode,
  type JurisdictionContext,
  type JurisdictionSource,
  type QueryMode,
} from '@/types/jurisdiction';

export const JURISDICTION_AUTH_ERROR = {
  HOME_JURISDICTION_REQUIRED: 'HOME_JURISDICTION_REQUIRED',
  JURISDICTION_NOT_ENTITLED: 'JURISDICTION_NOT_ENTITLED',
  COMPARISON_NOT_ENTITLED: 'COMPARISON_NOT_ENTITLED',
} as const;

export type JurisdictionAuthorizationErrorCode =
  | keyof typeof JURISDICTION_AUTH_ERROR
  | JurisdictionContractError['code'];

export class JurisdictionAuthorizationError extends Error {
  constructor(
    public readonly code: JurisdictionAuthorizationErrorCode,
    message: string,
    public readonly statusCode: 400 | 403 = 403,
  ) {
    super(message);
    this.name = 'JurisdictionAuthorizationError';
  }
}

export interface JurisdictionEntitlementRule {
  restrictedToHomeJurisdiction: boolean;
  comparisonAllowed: boolean;
  maxJurisdictions: number;
}

export const JURISDICTION_ENTITLEMENTS: Record<EffectivePlan, JurisdictionEntitlementRule> = {
  REGULATOR: {
    restrictedToHomeJurisdiction: true,
    comparisonAllowed: false,
    maxJurisdictions: 1,
  },
  FREE_TRIAL: {
    restrictedToHomeJurisdiction: true,
    comparisonAllowed: false,
    maxJurisdictions: 1,
  },
  STARTUP: {
    restrictedToHomeJurisdiction: false,
    comparisonAllowed: true,
    maxJurisdictions: 4,
  },
  BUSINESS: {
    restrictedToHomeJurisdiction: false,
    comparisonAllowed: true,
    maxJurisdictions: 4,
  },
  ENTERPRISE: {
    restrictedToHomeJurisdiction: false,
    comparisonAllowed: true,
    maxJurisdictions: 4,
  },
};

export interface ResolvedJurisdictionEntitlement {
  homeJurisdiction: JurisdictionCode;
  requestedJurisdictions: JurisdictionCode[];
  allowedJurisdictions: JurisdictionCode[];
  mode: QueryMode;
  comparisonAllowed: boolean;
  jurisdictionContext: JurisdictionContext;
}

interface JurisdictionPrismaReader {
  organization: {
    findUnique(args: {
      where: { id: string };
      select: { id: true; homeJurisdictionCode: true };
    }): Promise<{ id: string; homeJurisdictionCode: string | null } | null>;
  };
}

interface ResolveJurisdictionEntitlementInput {
  prisma: JurisdictionPrismaReader;
  organizationId: string;
  effectivePlan: EffectivePlan;
  requestedMode?: QueryMode;
  requestedJurisdictions?: readonly JurisdictionCode[];
  allowLegacyDefault?: boolean;
  source?: JurisdictionSource;
  audit?: {
    userId?: string;
    route?: string;
  };
}

export function toTrpcJurisdictionAuthorizationError(error: unknown): TRPCError {
  if (error instanceof JurisdictionAuthorizationError) {
    return new TRPCError({
      code: error.statusCode === 400 ? 'BAD_REQUEST' : 'FORBIDDEN',
      message: error.code,
      cause: error,
    });
  }

  if (error instanceof JurisdictionContractError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: error.code,
      cause: error,
    });
  }

  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'JURISDICTION_AUTHORIZATION_FAILED',
    cause: error,
  });
}

function enabledJurisdictions(): JurisdictionCode[] {
  return Object.values(JURISDICTION_CAPABILITIES)
    .filter((capability) => capability.queryEnabled && capability.status === 'ACTIVE')
    .map((capability) => capability.code);
}

function deny(input: ResolveJurisdictionEntitlementInput, details: {
  code: JurisdictionAuthorizationErrorCode;
  message: string;
  statusCode?: 400 | 403;
  homeJurisdiction?: JurisdictionCode | null;
  requestedJurisdictions?: readonly JurisdictionCode[];
}): never {
  logger.warn({
    type: 'jurisdiction_authorization_denied',
    userId: input.audit?.userId,
    orgId: input.organizationId,
    route: input.audit?.route,
    effectivePlan: input.effectivePlan,
    homeJurisdiction: details.homeJurisdiction ?? null,
    requestedJurisdictions: details.requestedJurisdictions ?? input.requestedJurisdictions ?? [],
    mode: input.requestedMode,
    reason: details.code,
  });

  throw new JurisdictionAuthorizationError(details.code, details.message, details.statusCode ?? 403);
}

export async function resolveJurisdictionEntitlement(
  input: ResolveJurisdictionEntitlementInput,
): Promise<ResolvedJurisdictionEntitlement> {
  const organization = await input.prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { id: true, homeJurisdictionCode: true },
  });

  if (!isJurisdictionCode(organization?.homeJurisdictionCode)) {
    deny(input, {
      code: 'HOME_JURISDICTION_REQUIRED',
      message: 'Organization home jurisdiction must be assigned before regulatory intelligence can be used.',
      statusCode: 403,
    });
  }

  const homeJurisdiction = organization.homeJurisdictionCode;
  const rule = JURISDICTION_ENTITLEMENTS[input.effectivePlan] ?? JURISDICTION_ENTITLEMENTS.REGULATOR;
  const allowedJurisdictions = rule.restrictedToHomeJurisdiction
    ? [homeJurisdiction]
    : enabledJurisdictions();
  const useOrganizationHome =
    input.source === 'ORGANIZATION_HOME' && (input.requestedJurisdictions?.length ?? 0) === 0;

  const jurisdictionContext = resolveJurisdictionContext(
    {
      mode: useOrganizationHome ? 'SINGLE' : input.requestedMode,
      jurisdictions: useOrganizationHome ? [homeJurisdiction] : input.requestedJurisdictions,
    },
    {
      allowLegacyDefault: input.allowLegacyDefault,
      source: input.source,
    },
  );

  const requestedJurisdictions = [...jurisdictionContext.jurisdictions];

  if (jurisdictionContext.mode === 'COMPARE' && !rule.comparisonAllowed) {
    deny(input, {
      code: 'COMPARISON_NOT_ENTITLED',
      message: 'Your plan does not include jurisdiction comparison.',
      homeJurisdiction,
      requestedJurisdictions,
    });
  }

  if (requestedJurisdictions.length > rule.maxJurisdictions) {
    deny(input, {
      code: 'COMPARISON_NOT_ENTITLED',
      message: 'Your plan does not include this many jurisdictions.',
      homeJurisdiction,
      requestedJurisdictions,
    });
  }

  const unauthorized = requestedJurisdictions.filter((code) => !allowedJurisdictions.includes(code));
  if (unauthorized.length > 0) {
    deny(input, {
      code: 'JURISDICTION_NOT_ENTITLED',
      message: 'Your plan does not include the requested jurisdiction.',
      homeJurisdiction,
      requestedJurisdictions,
    });
  }

  logger.info({
    type: 'jurisdiction_authorization_allowed',
    userId: input.audit?.userId,
    orgId: input.organizationId,
    route: input.audit?.route,
    effectivePlan: input.effectivePlan,
    homeJurisdiction,
    requestedJurisdictions,
    allowedJurisdictions,
    mode: jurisdictionContext.mode,
  });

  return {
    homeJurisdiction,
    requestedJurisdictions,
    allowedJurisdictions,
    mode: jurisdictionContext.mode,
    comparisonAllowed: rule.comparisonAllowed,
    jurisdictionContext,
  };
}
