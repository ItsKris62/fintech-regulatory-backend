import { describe, expect, it, vi } from 'vitest';
import { MemberRole, MemberStatus } from '@prisma/client';
import {
  type BackfillDependencies,
  type LegacyUserCandidate,
  buildInitialReport,
  buildMembershipCreateInput,
  classifyLegacyMembershipCase,
  membershipCacheKeysFor,
  runOrganizationMembershipBackfill,
} from './backfill-organization-memberships';

function user(overrides: {
  id: string;
  organizationId: string | null;
  memberships?: LegacyUserCandidate['organizationMemberships'];
  organization?: { id: string } | null;
}): LegacyUserCandidate {
  return {
    id: overrides.id,
    organizationId: overrides.organizationId,
    organization: overrides.organization === undefined && overrides.organizationId
      ? { id: overrides.organizationId }
      : overrides.organization ?? null,
    organizationMemberships: overrides.memberships ?? [],
  };
}

function dependencies(candidates: LegacyUserCandidate[]): {
  deps: BackfillDependencies;
  createMembership: ReturnType<typeof vi.fn<BackfillDependencies['createMembership']>>;
  deleteCacheKey: ReturnType<typeof vi.fn<BackfillDependencies['deleteCacheKey']>>;
} {
  const createMembership = vi.fn<BackfillDependencies['createMembership']>().mockResolvedValue(undefined);
  const deleteCacheKey = vi.fn<BackfillDependencies['deleteCacheKey']>().mockResolvedValue(1);

  return {
    createMembership,
    deleteCacheKey,
    deps: {
      findCandidates: vi.fn<BackfillDependencies['findCandidates']>().mockResolvedValue(candidates),
      findMemberships: vi.fn<BackfillDependencies['findMemberships']>().mockResolvedValue([]),
      createMembership,
      deleteCacheKey,
    },
  };
}

describe('organization membership backfill classification', () => {
  it('reports an existing active matching membership without creating anything', () => {
    const item = classifyLegacyMembershipCase(user({
      id: 'user_1',
      organizationId: 'org_1',
      memberships: [{
        id: 'member_1',
        organizationId: 'org_1',
        role: MemberRole.ADMIN,
        status: MemberStatus.ACTIVE,
      }],
    }));

    expect(item.classification).toBe('existing_active');
    expect(item.wouldCreate).toBe(false);

    const report = buildInitialReport('dry-run', [user({
      id: 'user_1',
      organizationId: 'org_1',
      memberships: [{
        id: 'member_1',
        organizationId: 'org_1',
        role: MemberRole.ADMIN,
        status: MemberStatus.ACTIVE,
      }],
    })]);

    expect(report.existingActive).toBe(1);
    expect(report.wouldCreate).toBe(0);
  });

  it('plans a safe MEMBER membership for a missing membership in dry-run', () => {
    const item = classifyLegacyMembershipCase(user({ id: 'user_1', organizationId: 'org_1' }));

    expect(item.classification).toBe('missing_would_create');
    expect(item.wouldCreate).toBe(true);
    expect(buildMembershipCreateInput('user_1', 'org_1')).toEqual({
      userId: 'user_1',
      organizationId: 'org_1',
      role: MemberRole.MEMBER,
      status: MemberStatus.ACTIVE,
    });
  });

  it('skips existing non-active memberships instead of overwriting them', () => {
    const item = classifyLegacyMembershipCase(user({
      id: 'user_1',
      organizationId: 'org_1',
      memberships: [{
        id: 'member_1',
        organizationId: 'org_1',
        role: MemberRole.OWNER,
        status: MemberStatus.REMOVED,
      }],
    }));

    expect(item).toMatchObject({
      classification: 'existing_non_active',
      userId: 'user_1',
      organizationId: 'org_1',
      existingStatus: MemberStatus.REMOVED,
      existingRole: MemberRole.OWNER,
      wouldCreate: false,
    });
  });

  it('reports missing organizations as ambiguous', () => {
    const item = classifyLegacyMembershipCase(
      user({ id: 'user_1', organizationId: 'org_missing', organization: null }),
    );

    expect(item).toMatchObject({
      classification: 'ambiguous_org_missing',
      userId: 'user_1',
      organizationId: 'org_missing',
      wouldCreate: false,
    });
  });

  it('reports other active organization memberships as ambiguous', () => {
    const item = classifyLegacyMembershipCase(user({
      id: 'user_1',
      organizationId: 'org_1',
      memberships: [{
        id: 'member_2',
        organizationId: 'org_2',
        role: MemberRole.MEMBER,
        status: MemberStatus.ACTIVE,
      }],
    }));

    expect(item).toMatchObject({
      classification: 'ambiguous_other_active_org',
      otherActiveOrganizationIds: ['org_2'],
      wouldCreate: false,
    });
  });

  it('uses the expected membership cache keys', () => {
    expect(membershipCacheKeysFor('user_1', 'org_1')).toEqual([
      'sheriabot:orgmem:user_1:org_1',
      'sheriabot:planctx:user_1',
    ]);
  });
});

describe('organization membership backfill runner', () => {
  it('does not write or invalidate caches in dry-run mode', async () => {
    const { deps, createMembership, deleteCacheKey } = dependencies([
      user({ id: 'user_1', organizationId: 'org_1' }),
    ]);

    const report = await runOrganizationMembershipBackfill(
      { mode: 'dry-run', verbose: false, json: false },
      deps,
    );

    expect(report.wouldCreate).toBe(1);
    expect(report.created).toBe(0);
    expect(createMembership).not.toHaveBeenCalled();
    expect(deleteCacheKey).not.toHaveBeenCalled();
  });

  it('creates missing memberships with MEMBER/ACTIVE and invalidates caches in apply mode', async () => {
    const { deps, createMembership, deleteCacheKey } = dependencies([
      user({ id: 'user_1', organizationId: 'org_1' }),
    ]);

    const report = await runOrganizationMembershipBackfill(
      { mode: 'apply', verbose: false, json: false },
      deps,
    );

    expect(createMembership).toHaveBeenCalledWith({
      userId: 'user_1',
      organizationId: 'org_1',
      role: MemberRole.MEMBER,
      status: MemberStatus.ACTIVE,
    });
    expect(deleteCacheKey).toHaveBeenCalledWith('sheriabot:orgmem:user_1:org_1');
    expect(deleteCacheKey).toHaveBeenCalledWith('sheriabot:planctx:user_1');
    expect(report.created).toBe(1);
    expect(report.cachesInvalidated).toBe(2);
  });
});
