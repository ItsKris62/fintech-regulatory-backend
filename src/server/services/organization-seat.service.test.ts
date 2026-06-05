import { MemberStatus, SubscriptionPlan } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  findPendingOrganizationInvite,
  getSeatUsageForOrganization,
  hasSeatCapacity,
} from './organization-seat.service';

function prismaMock(input: {
  plan?: SubscriptionPlan;
  maxSeats?: number;
  activeMembers: number;
  pendingInvites: number;
  pilotAccess?: { entitlementProfile: string | null } | null;
  pendingInvite?: { id: string } | null;
}) {
  return {
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        plan: input.plan ?? SubscriptionPlan.BUSINESS,
        maxSeats: input.maxSeats ?? 1,
      }),
    },
    organizationMember: {
      count: vi.fn().mockResolvedValue(input.activeMembers),
    },
    invitation: {
      count: vi.fn().mockResolvedValue(input.pendingInvites),
      findFirst: vi.fn().mockResolvedValue(input.pendingInvite ?? null),
    },
    pilotAccess: {
      findFirst: vi.fn().mockResolvedValue(input.pilotAccess ?? null),
    },
  };
}

describe('organization seat usage', () => {
  it('counts Business as six total seats including pending invites', async () => {
    const prisma = prismaMock({
      plan: SubscriptionPlan.BUSINESS,
      activeMembers: 5,
      pendingInvites: 1,
    });

    const usage = await getSeatUsageForOrganization(prisma as any, 'org_1');

    expect(usage).toEqual({
      seatLimit: 6,
      activeMembers: 5,
      pendingInvites: 1,
      usedSeats: 6,
      availableSeats: 0,
    });
    expect(hasSeatCapacity(usage)).toBe(false);
    expect(prisma.organizationMember.count).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_1',
        status: { in: [MemberStatus.ACTIVE, MemberStatus.SUSPENDED] },
      },
    });
    expect(prisma.invitation.count).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_1',
        used: false,
        expiresAt: { gt: expect.any(Date) },
      },
    });
  });

  it('allows Business to invite when five active members have no pending invites', async () => {
    const usage = await getSeatUsageForOrganization(
      prismaMock({
        plan: SubscriptionPlan.BUSINESS,
        activeMembers: 5,
        pendingInvites: 0,
      }) as any,
      'org_1',
    );

    expect(usage.availableSeats).toBe(1);
    expect(hasSeatCapacity(usage)).toBe(true);
  });

  it('does not count removed members because only active and suspended statuses are queried', async () => {
    const prisma = prismaMock({
      plan: SubscriptionPlan.BUSINESS,
      activeMembers: 5,
      pendingInvites: 0,
    });

    const usage = await getSeatUsageForOrganization(prisma as any, 'org_1');

    expect(usage.availableSeats).toBe(1);
    expect(prisma.organizationMember.count).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_1',
        status: { in: [MemberStatus.ACTIVE, MemberStatus.SUSPENDED] },
      },
    });
  });

  it('does not count expired or already-used invites because only live unused invites are queried', async () => {
    const prisma = prismaMock({
      plan: SubscriptionPlan.BUSINESS,
      activeMembers: 5,
      pendingInvites: 0,
    });

    const usage = await getSeatUsageForOrganization(prisma as any, 'org_1');

    expect(usage.availableSeats).toBe(1);
    expect(prisma.invitation.count).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_1',
        used: false,
        expiresAt: { gt: expect.any(Date) },
      },
    });
  });

  it('uses configured Enterprise seats when an Enterprise org is not unlimited operationally', async () => {
    const usage = await getSeatUsageForOrganization(
      prismaMock({
        plan: SubscriptionPlan.ENTERPRISE,
        maxSeats: 75,
        activeMembers: 74,
        pendingInvites: 1,
      }) as any,
      'org_1',
    );

    expect(usage.seatLimit).toBe(75);
    expect(usage.availableSeats).toBe(0);
  });

  it('follows the active pilot entitlement profile for pilot organizations', async () => {
    const usage = await getSeatUsageForOrganization(
      prismaMock({
        plan: SubscriptionPlan.REGULATOR,
        activeMembers: 10,
        pendingInvites: 2,
        pilotAccess: { entitlementProfile: 'PILOT_FULL' },
      }) as any,
      'org_1',
    );

    expect(usage.seatLimit).toBe(-1);
    expect(usage.availableSeats).toBe(-1);
  });

  it('falls back to the paid plan seat limit when no active pilot access exists', async () => {
    const usage = await getSeatUsageForOrganization(
      prismaMock({
        plan: SubscriptionPlan.BUSINESS,
        activeMembers: 5,
        pendingInvites: 0,
        pilotAccess: null,
      }) as any,
      'org_1',
    );

    expect(usage.seatLimit).toBe(6);
    expect(usage.availableSeats).toBe(1);
  });

  it('finds duplicate pending invites by normalized email', async () => {
    const prisma = prismaMock({
      activeMembers: 0,
      pendingInvites: 0,
      pendingInvite: { id: 'invite_1' },
    });

    await expect(findPendingOrganizationInvite(prisma as any, 'org_1', 'USER@Example.COM'))
      .resolves.toEqual({ id: 'invite_1' });

    expect(prisma.invitation.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_1',
        email: 'user@example.com',
        used: false,
        expiresAt: { gt: expect.any(Date) },
      },
      select: { id: true },
    });
  });
});
