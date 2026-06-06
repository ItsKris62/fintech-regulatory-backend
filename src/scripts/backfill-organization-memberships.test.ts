import { describe, expect, it } from 'vitest';
import { MemberRole, MemberStatus } from '@prisma/client';
import {
  buildOrganizationMembershipBackfillPlan,
  membershipCacheKeysFor,
} from './backfill-organization-memberships';

function user(overrides: {
  id: string;
  organizationId: string | null;
  memberships?: Array<{
    id: string;
    organizationId: string;
    role: MemberRole;
    status: MemberStatus;
  }>;
  organization?: { id: string } | null;
}) {
  return {
    email: `${overrides.id}@example.test`,
    organization: overrides.organization === undefined && overrides.organizationId
      ? { id: overrides.organizationId }
      : overrides.organization ?? null,
    organizationMemberships: overrides.memberships ?? [],
    ...overrides,
  };
}

describe('organization membership backfill planner', () => {
  it('does nothing when a matching active membership already exists', () => {
    const plan = buildOrganizationMembershipBackfillPlan([
      user({
        id: 'user_1',
        organizationId: 'org_1',
        memberships: [{
          id: 'member_1',
          organizationId: 'org_1',
          role: MemberRole.ADMIN,
          status: MemberStatus.ACTIVE,
        }],
      }),
    ]);

    expect(plan.existingMemberships).toBe(1);
    expect(plan.creates).toEqual([]);
    expect(plan.ambiguous).toEqual([]);
  });

  it('plans a safe MEMBER membership for a legacy user with no membership', () => {
    const plan = buildOrganizationMembershipBackfillPlan([
      user({ id: 'user_1', organizationId: 'org_1' }),
    ]);

    expect(plan.missingMemberships).toBe(1);
    expect(plan.creates).toEqual([{
      userId: 'user_1',
      email: 'user_1@example.test',
      organizationId: 'org_1',
      role: MemberRole.MEMBER,
    }]);
  });

  it('skips existing non-active memberships instead of overwriting them', () => {
    const plan = buildOrganizationMembershipBackfillPlan([
      user({
        id: 'user_1',
        organizationId: 'org_1',
        memberships: [{
          id: 'member_1',
          organizationId: 'org_1',
          role: MemberRole.OWNER,
          status: MemberStatus.REMOVED,
        }],
      }),
    ]);

    expect(plan.creates).toEqual([]);
    expect(plan.ambiguous).toMatchObject([{
      userId: 'user_1',
      organizationId: 'org_1',
      reason: 'existing_non_active_membership',
      existingStatus: MemberStatus.REMOVED,
      existingRole: MemberRole.OWNER,
    }]);
  });

  it('reports missing organizations as ambiguous', () => {
    const plan = buildOrganizationMembershipBackfillPlan([
      user({ id: 'user_1', organizationId: 'org_missing', organization: null }),
    ]);

    expect(plan.creates).toEqual([]);
    expect(plan.ambiguous).toMatchObject([{
      userId: 'user_1',
      organizationId: 'org_missing',
      reason: 'missing_organization',
    }]);
  });

  it('uses the expected membership cache keys', () => {
    expect(membershipCacheKeysFor('user_1', 'org_1')).toEqual([
      'sheriabot:orgmem:user_1:org_1',
      'sheriabot:planctx:user_1',
    ]);
  });
});
