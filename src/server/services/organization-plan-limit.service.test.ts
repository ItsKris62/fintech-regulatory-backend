import { MemberStatus, SubscriptionPlan, UserRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  BUSINESS_ORG_LIMIT_MESSAGE,
  assertCanCreateOrJoinOrganization,
} from './organization-plan-limit.service';

function prismaMock(input: {
  user?: { id: string; role?: UserRole; organizationId?: string | null } | null;
  memberships?: Array<{
    organizationId: string;
    status: MemberStatus;
    organization: { id: string; plan: SubscriptionPlan; deletedAt?: Date | null };
  }>;
  targetPlan?: SubscriptionPlan | null;
  targetDeletedAt?: Date | null;
}) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue(input.user ?? { id: 'user_1', role: UserRole.STARTUP, organizationId: null }),
    },
    organization: {
      findUnique: vi.fn().mockResolvedValue(
        input.targetPlan
          ? { id: 'target_org', plan: input.targetPlan, deletedAt: input.targetDeletedAt ?? null }
          : null,
      ),
    },
    organizationMember: {
      findMany: vi.fn().mockResolvedValue(input.memberships ?? []),
    },
  };
}

function actor(role: UserRole = UserRole.STARTUP, platformAdminOverride = false) {
  return {
    actorUserId: 'actor_1',
    actorRole: role,
    sourceProcedure: 'test',
    platformAdminOverride,
  };
}

describe('organization plan limit guard', () => {
  it('allows Business users with no active organization to create or join the first organization', async () => {
    const prisma = prismaMock({ memberships: [] });

    await expect(assertCanCreateOrJoinOrganization({
      prisma: prisma as any,
      userId: 'user_1',
      requestedPlan: SubscriptionPlan.BUSINESS,
      actorContext: actor(),
    })).resolves.toBeUndefined();
  });

  it('blocks a Business user with one active organization from creating or joining another organization', async () => {
    const prisma = prismaMock({
      memberships: [{
        organizationId: 'business_org_1',
        status: MemberStatus.ACTIVE,
        organization: { id: 'business_org_1', plan: SubscriptionPlan.BUSINESS, deletedAt: null },
      }],
    });

    await expect(assertCanCreateOrJoinOrganization({
      prisma: prisma as any,
      userId: 'user_1',
      requestedPlan: SubscriptionPlan.BUSINESS,
      actorContext: actor(),
    })).rejects.toMatchObject({ message: BUSINESS_ORG_LIMIT_MESSAGE });
  });

  it('counts the user session organization when a legacy OrganizationMember row is missing', async () => {
    const prisma = prismaMock({
      user: { id: 'user_1', role: UserRole.STARTUP, organizationId: 'business_org_1' },
      memberships: [],
      targetPlan: SubscriptionPlan.BUSINESS,
    });

    await expect(assertCanCreateOrJoinOrganization({
      prisma: prisma as any,
      userId: 'user_1',
      targetOrganizationId: 'business_org_2',
      actorContext: actor(),
    })).rejects.toMatchObject({ message: BUSINESS_ORG_LIMIT_MESSAGE });

    expect(prisma.organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'business_org_1' },
      select: { id: true, plan: true, deletedAt: true },
    });
  });

  it('ignores removed memberships when applying Startup and Business one-organization limits', async () => {
    const prisma = prismaMock({
      memberships: [{
        organizationId: 'removed_org',
        status: MemberStatus.REMOVED,
        organization: { id: 'removed_org', plan: SubscriptionPlan.BUSINESS, deletedAt: null },
      }],
    });

    await expect(assertCanCreateOrJoinOrganization({
      prisma: prisma as any,
      userId: 'user_1',
      requestedPlan: SubscriptionPlan.STARTUP,
      actorContext: actor(),
    })).resolves.toBeUndefined();
  });

  it('does not restrict Enterprise multi-organization behavior', async () => {
    const prisma = prismaMock({
      memberships: [{
        organizationId: 'enterprise_org_1',
        status: MemberStatus.ACTIVE,
        organization: { id: 'enterprise_org_1', plan: SubscriptionPlan.ENTERPRISE, deletedAt: null },
      }],
    });

    await expect(assertCanCreateOrJoinOrganization({
      prisma: prisma as any,
      userId: 'user_1',
      requestedPlan: SubscriptionPlan.ENTERPRISE,
      actorContext: actor(UserRole.ENTERPRISE),
    })).resolves.toBeUndefined();
  });

  it('allows explicit Platform Super Admin provisioning overrides', async () => {
    const prisma = prismaMock({
      memberships: [{
        organizationId: 'business_org_1',
        status: MemberStatus.ACTIVE,
        organization: { id: 'business_org_1', plan: SubscriptionPlan.BUSINESS, deletedAt: null },
      }],
    });

    await expect(assertCanCreateOrJoinOrganization({
      prisma: prisma as any,
      userId: 'user_1',
      requestedPlan: SubscriptionPlan.BUSINESS,
      actorContext: actor(UserRole.ADMIN, true),
    })).resolves.toBeUndefined();

    expect(prisma.organizationMember.findMany).not.toHaveBeenCalled();
  });
});
