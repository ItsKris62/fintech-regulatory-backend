import { MemberRole, MemberStatus, SubscriptionPlan, Prisma, PrismaClient } from '@prisma/client';
import { logger } from '@/utils/logger';
import { subscriptionTierToPlanOrFree } from '@/utils/plan-mapping';

export interface ProvisionOrganizationParams {
  user: {
    id: string;
    email: string;
    fullName?: string | null;
    role?: string;
    organizationId?: string | null;
  };
  companyName?: string | null;
  homeJurisdictionCode?: string | null;
  defaultSubscriptionTier?: string;
}

export interface ProvisionOrganizationResult {
  organizationId: string;
  organizationName: string;
  membershipId: string;
  isNew: boolean;
}

/**
 * Service to provision a default organization and owner membership for a user in an idempotent, atomic manner.
 * Can be executed inside a Prisma interactive transaction (tx) or standalone with the Prisma client.
 */
export async function provisionDefaultOrganization(
  tx: Prisma.TransactionClient | PrismaClient,
  params: ProvisionOrganizationParams
): Promise<ProvisionOrganizationResult> {
  const db = tx as PrismaClient;
  const { user, companyName, homeJurisdictionCode, defaultSubscriptionTier = 'starter' } = params;

  // 1. If user already has an organization linked, verify it exists and return it
  if (user.organizationId) {
    const existingOrg = await db.organization.findUnique({
      where: { id: user.organizationId },
      select: { id: true, name: true },
    });

    if (existingOrg) {
      // Ensure user has an ACTIVE membership in this organization
      const membership = await db.organizationMember.upsert({
        where: {
          userId_organizationId: {
            userId: user.id,
            organizationId: existingOrg.id,
          },
        },
        create: {
          userId: user.id,
          organizationId: existingOrg.id,
          role: MemberRole.OWNER,
          status: MemberStatus.ACTIVE,
          joinedAt: new Date(),
        },
        update: {
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      });

      return {
        organizationId: existingOrg.id,
        organizationName: existingOrg.name,
        membershipId: membership.id,
        isNew: false,
      };
    }
  }

  // 2. Check if user already has any active organization membership
  const existingMembership = await db.organizationMember.findFirst({
    where: {
      userId: user.id,
      status: MemberStatus.ACTIVE,
    },
    include: {
      organization: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (existingMembership?.organization) {
    // Sync User.organizationId if it was not set
    await db.user.update({
      where: { id: user.id },
      data: { organizationId: existingMembership.organization.id },
    });

    return {
      organizationId: existingMembership.organization.id,
      organizationName: existingMembership.organization.name,
      membershipId: existingMembership.id,
      isNew: false,
    };
  }

  // 3. Derive clean organization name
  const rawName = companyName?.trim() ||
    (user.fullName ? `${user.fullName.trim()}'s Organization` : null) ||
    `${user.email.split('@')[0]}'s Workspace`;

  const orgName = rawName.substring(0, 100);
  const resolvedRole = user.role || 'USER';
  const orgType = resolvedRole === 'REGULATOR' ? 'regulator' : 'startup';
  const resolvedPlan = subscriptionTierToPlanOrFree(defaultSubscriptionTier);

  // 4. Create Organization
  const org = await db.organization.create({
    data: {
      name: orgName,
      type: resolvedRole,
      organizationType: orgType,
      subscriptionTier: defaultSubscriptionTier,
      plan: resolvedPlan as SubscriptionPlan,
      homeJurisdictionCode: homeJurisdictionCode || null,
      enabledJurisdictions: homeJurisdictionCode ? [homeJurisdictionCode] : [],
      needsCountryConfirmation: !homeJurisdictionCode,
      users: { connect: { id: user.id } },
    },
    select: { id: true, name: true },
  });

  // 5. Update user organizationId
  await db.user.update({
    where: { id: user.id },
    data: { organizationId: org.id },
  });

  // 6. Create OWNER membership
  const membership = await db.organizationMember.create({
    data: {
      userId: user.id,
      organizationId: org.id,
      role: MemberRole.OWNER,
      status: MemberStatus.ACTIVE,
      joinedAt: new Date(),
    },
    select: { id: true },
  });

  logger.info({
    type: 'organization_default_provisioned',
    userId: user.id,
    organizationId: org.id,
    organizationName: org.name,
  });

  return {
    organizationId: org.id,
    organizationName: org.name,
    membershipId: membership.id,
    isNew: true,
  };
}
