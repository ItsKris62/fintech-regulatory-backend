import { describe, expect, it } from 'vitest';
import { MemberRole, SubscriptionPlan } from '@prisma/client';
import {
  createOrganizationInvitationLocked,
  hashInvitationToken,
  invitationTokenWhere,
} from './organization-invitation.service';

function createMutex() {
  let tail = Promise.resolve();
  return async () => {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const previous = tail;
    tail = tail.then(() => next);
    await previous;
    return release;
  };
}

function createHarness(input: { activeMembers: number }) {
  const invitations: any[] = [];
  const acquire = createMutex();

  async function run<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    let release: any = null;
    const tx = {
      $executeRaw: async () => {
        release = await acquire();
      },
      organization: {
        findUnique: async () => ({ id: 'org_1', plan: SubscriptionPlan.BUSINESS, maxSeats: 1, deletedAt: null }),
      },
      pilotAccess: {
        findFirst: async () => null,
      },
      organizationMember: {
        count: async () => input.activeMembers,
        findFirst: async ({ where }: any) => where.user?.email === 'member@example.com' ? { id: 'member_1' } : null,
      },
      invitation: {
        count: async () => invitations.filter((invite) => !invite.used && !invite.revokedAt && invite.expiresAt > new Date()).length,
        findFirst: async ({ where }: any) => invitations.find((invite) =>
          invite.organizationId === where.organizationId &&
          invite.email === where.email &&
          !invite.used &&
          !invite.revokedAt &&
          invite.expiresAt > new Date()
        ) ?? null,
        create: async ({ data }: any) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          const invite = { id: `invite_${invitations.length + 1}`, createdAt: new Date(), ...data };
          invitations.push(invite);
          return invite;
        },
      },
    };

    try {
      return await fn(tx);
    } finally {
      if (typeof release === 'function') release();
    }
  }

  return { invitations, run };
}

describe('organization invitation security helpers', () => {
  it('hashes raw invitation tokens and supports digest lookup', () => {
    const digest = hashInvitationToken('raw-token');

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toBe('raw-token');
    expect(invitationTokenWhere('raw-token')).toEqual([{ token: digest }, { token: 'raw-token' }]);
  });

  it('serializes final-seat invitation creation so exactly one concurrent request wins', async () => {
    const harness = createHarness({ activeMembers: 5 });

    const invite = (email: string) => harness.run((tx) => createOrganizationInvitationLocked({
      tx,
      actorUserId: 'owner_1',
      organizationId: 'org_1',
      email,
      organizationRole: MemberRole.MEMBER,
      expiresInDays: 7,
    }));

    const results = await Promise.allSettled([
      invite('a@example.com'),
      invite('b@example.com'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(harness.invitations).toHaveLength(1);
  });

  it('serializes duplicate email invitation creation so exactly one request wins', async () => {
    const harness = createHarness({ activeMembers: 4 });

    const invite = () => harness.run((tx) => createOrganizationInvitationLocked({
      tx,
      actorUserId: 'owner_1',
      organizationId: 'org_1',
      email: 'same@example.com',
      organizationRole: MemberRole.MEMBER,
      expiresInDays: 7,
    }));

    const results = await Promise.allSettled([invite(), invite()]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(harness.invitations).toHaveLength(1);
  });
});
