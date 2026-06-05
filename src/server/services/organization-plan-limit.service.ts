import { TRPCError } from '@trpc/server';
import { MemberStatus, SubscriptionPlan, UserRole } from '@prisma/client';
import { logger } from '@/utils/logger';

export const BUSINESS_ORG_LIMIT_MESSAGE =
  'Your Business plan supports one organization. To manage multiple organizations, contact SheriaBot for Enterprise access.';

type PrismaLike = {
  user: {
    findUnique(args: unknown): Promise<{
      id: string;
      role?: UserRole | string | null;
      organizationId?: string | null;
    } | null>;
  };
  organization: {
    findUnique(args: unknown): Promise<{
      id: string;
      plan?: SubscriptionPlan | null;
      deletedAt?: Date | null;
    } | null>;
  };
  organizationMember: {
    findMany(args: unknown): Promise<Array<{
      organizationId: string;
      role?: string | null;
      status: MemberStatus | string;
      organization?: {
        id: string;
        plan?: SubscriptionPlan | null;
        deletedAt?: Date | null;
      } | null;
    }>>;
  };
};

type ActorContext = {
  actorUserId: string;
  actorRole: UserRole | string;
  sourceProcedure: string;
  platformAdminOverride?: boolean;
};

export type AssertCanCreateOrJoinOrganizationInput = {
  prisma: PrismaLike;
  userId: string;
  targetOrganizationId?: string | null;
  requestedPlan?: SubscriptionPlan | null;
  actorContext: ActorContext;
};

const ONE_ORG_LIMIT_PLANS = new Set<SubscriptionPlan>([
  SubscriptionPlan.STARTUP,
  SubscriptionPlan.BUSINESS,
]);

function isPlatformAdminOverride(actorContext: ActorContext): boolean {
  return actorContext.actorRole === UserRole.ADMIN && actorContext.platformAdminOverride === true;
}

function isOneOrgLimitedPlan(plan: SubscriptionPlan | null | undefined): boolean {
  return plan !== null && plan !== undefined && ONE_ORG_LIMIT_PLANS.has(plan);
}

function firstLimitedMembership(
  memberships: Array<{
    organizationId: string;
    status: MemberStatus | string;
    organization?: { plan?: SubscriptionPlan | null; deletedAt?: Date | null } | null;
  }>,
  targetOrganizationId?: string | null,
) {
  return memberships.find((membership) => {
    if (membership.status !== MemberStatus.ACTIVE) return false;
    if (targetOrganizationId && membership.organizationId === targetOrganizationId) return false;
    if (membership.organization?.deletedAt) return false;
    return isOneOrgLimitedPlan(membership.organization?.plan);
  });
}

async function getTargetPlan(
  prisma: PrismaLike,
  targetOrganizationId?: string | null,
  requestedPlan?: SubscriptionPlan | null,
): Promise<SubscriptionPlan | null> {
  if (requestedPlan) return requestedPlan;
  if (!targetOrganizationId) return null;

  const organization = await prisma.organization.findUnique({
    where: { id: targetOrganizationId },
    select: { id: true, plan: true, deletedAt: true },
  });

  if (!organization || organization.deletedAt) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found.' });
  }

  return organization.plan ?? null;
}

/**
 * Central guard for one-organization plan semantics.
 *
 * Startup and Business are single-organization commercial contexts. Enterprise
 * is intentionally left flexible because contract-aware multi-org governance
 * is not modeled yet.
 */
export async function assertCanCreateOrJoinOrganization(
  input: AssertCanCreateOrJoinOrganizationInput,
): Promise<void> {
  const { prisma, userId, targetOrganizationId, requestedPlan, actorContext } = input;

  if (isPlatformAdminOverride(actorContext)) {
    logger.info({
      type: 'organization_plan_limit_admin_override',
      userId,
      attemptedOrganizationId: targetOrganizationId ?? null,
      actorRole: actorContext.actorRole,
      sourceProcedure: actorContext.sourceProcedure,
    });
    return;
  }

  const [user, memberships, targetPlan] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, organizationId: true },
    }),
    prisma.organizationMember.findMany({
      where: {
        userId,
        status: MemberStatus.ACTIVE,
      },
      select: {
        organizationId: true,
        role: true,
        status: true,
        organization: {
          select: {
            id: true,
            plan: true,
            deletedAt: true,
          },
        },
      },
    }),
    getTargetPlan(prisma, targetOrganizationId, requestedPlan),
  ]);

  if (!user) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found.' });
  }

  const effectiveMemberships = [...memberships];
  if (
    user.organizationId &&
    user.organizationId !== targetOrganizationId &&
    !effectiveMemberships.some((membership) => membership.organizationId === user.organizationId)
  ) {
    const sessionOrganization = await prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { id: true, plan: true, deletedAt: true },
    });

    if (sessionOrganization) {
      effectiveMemberships.push({
        organizationId: sessionOrganization.id,
        status: MemberStatus.ACTIVE,
        organization: sessionOrganization,
      });
    }
  }

  const existingLimitedMembership = firstLimitedMembership(effectiveMemberships, targetOrganizationId);
  const requestedLimitedPlan = isOneOrgLimitedPlan(targetPlan);

  if (existingLimitedMembership || requestedLimitedPlan) {
    const otherActiveMemberships = effectiveMemberships.filter((membership) => {
      if (membership.status !== MemberStatus.ACTIVE) return false;
      if (targetOrganizationId && membership.organizationId === targetOrganizationId) return false;
      return !membership.organization?.deletedAt;
    });

    if (otherActiveMemberships.length > 0 || existingLimitedMembership) {
      logger.warn({
        type: 'business_org_limit_blocked',
        userId,
        existingOrganizationId: existingLimitedMembership?.organizationId ?? otherActiveMemberships[0]?.organizationId ?? null,
        attemptedOrganizationId: targetOrganizationId ?? null,
        actorRole: actorContext.actorRole,
        sourceProcedure: actorContext.sourceProcedure,
      });

      throw new TRPCError({
        code: 'FORBIDDEN',
        message: BUSINESS_ORG_LIMIT_MESSAGE,
      });
    }
  }
}
