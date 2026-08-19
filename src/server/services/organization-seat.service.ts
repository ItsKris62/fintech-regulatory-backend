import { MemberStatus, SubscriptionPlan } from '@prisma/client';
import {
  PILOT_ENTITLEMENT_PROFILES,
  PLAN_ENTITLEMENTS,
  resolvePilotEntitlementProfile,
} from '@/config/entitlements.config';

type PrismaLike = {
  organization: {
    findUnique: (args: any) => Promise<any>;
  };
  organizationMember: {
    count: (args: any) => Promise<number>;
    findFirst?: (args: any) => Promise<any>;
  };
  invitation: {
    count: (args: any) => Promise<number>;
    findFirst: (args: any) => Promise<any>;
  };
  pilotAccess?: {
    findFirst: (args: any) => Promise<any>;
  };
};

export interface OrganizationSeatUsage {
  seatLimit: number;
  activeMembers: number;
  pendingInvites: number;
  usedSeats: number;
  availableSeats: number;
}

const SEAT_COUNTING_MEMBER_STATUSES = [
  MemberStatus.ACTIVE,
  MemberStatus.SUSPENDED,
];

export function buildSeatLimitMessage(usage: OrganizationSeatUsage): string {
  const planSeats = usage.seatLimit === 1 ? '1 seat' : `${usage.seatLimit} seats`;
  return `Your current plan includes ${planSeats} and all seats are currently used. Remove a member, wait for an invite to expire, or upgrade your plan to add more seats.`;
}

async function resolveSeatLimit(prisma: PrismaLike, organizationId: string, now: Date): Promise<number> {
  const [organization, pilotAccess] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: { plan: true, maxSeats: true },
    }),
    prisma.pilotAccess?.findFirst({
      where: {
        organizationId,
        status: 'ACTIVE',
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
      select: { entitlementProfile: true },
    }).catch(() => null) ?? Promise.resolve(null),
  ]);

  if (!organization) return 0;

  if (pilotAccess) {
    const profile = resolvePilotEntitlementProfile(pilotAccess.entitlementProfile);
    return PILOT_ENTITLEMENT_PROFILES[profile].maxSeats;
  }

  const entitlementLimit = PLAN_ENTITLEMENTS[organization.plan as SubscriptionPlan]?.maxSeats ?? 1;
  if (entitlementLimit !== -1) return entitlementLimit;

  return typeof organization.maxSeats === 'number' && organization.maxSeats > 0
    ? organization.maxSeats
    : entitlementLimit;
}

export async function getSeatUsageForOrganization(
  prisma: PrismaLike,
  organizationId: string,
  now = new Date(),
): Promise<OrganizationSeatUsage> {
  const [seatLimit, activeMembers, pendingInvites] = await Promise.all([
    resolveSeatLimit(prisma, organizationId, now),
    prisma.organizationMember.count({
      where: {
        organizationId,
        status: { in: SEAT_COUNTING_MEMBER_STATUSES },
      },
    }),
    prisma.invitation.count({
      where: {
        organizationId,
        used: false,
        revokedAt: null,
        expiresAt: { gt: now },
      },
    }),
  ]);

  const usedSeats = activeMembers + pendingInvites;
  const availableSeats = seatLimit === -1 ? -1 : Math.max(0, seatLimit - usedSeats);

  return {
    seatLimit,
    activeMembers,
    pendingInvites,
    usedSeats,
    availableSeats,
  };
}

export function hasSeatCapacity(usage: OrganizationSeatUsage): boolean {
  return usage.seatLimit === -1 || usage.usedSeats < usage.seatLimit;
}

export async function findPendingOrganizationInvite(
  prisma: PrismaLike,
  organizationId: string,
  email: string,
  now = new Date(),
): Promise<{ id: string } | null> {
  return prisma.invitation.findFirst({
    where: {
      organizationId,
      email: email.toLowerCase(),
      used: false,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true },
  });
}
