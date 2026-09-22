import { describe, expect, it, vi, beforeEach } from 'vitest';
import { provisionDefaultOrganization } from '../organization-provisioning.service';
import { MemberRole, MemberStatus } from '@prisma/client';

describe('organization-provisioning.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('provisions a new organization and OWNER membership when user has none', async () => {
    const mockTx = {
      organization: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'org_new_1',
          name: 'Acme Corp',
        }),
      },
      organizationMember: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'mem_new_1',
        }),
      },
      user: {
        update: vi.fn().mockResolvedValue({
          id: 'user_1',
          organizationId: 'org_new_1',
        }),
      },
    };

    const result = await provisionDefaultOrganization(mockTx as any, {
      user: {
        id: 'user_1',
        email: 'founder@acme.com',
        fullName: 'Jane Founder',
        role: 'USER',
        organizationId: null,
      },
      companyName: 'Acme Corp',
      homeJurisdictionCode: 'KEN',
      defaultSubscriptionTier: 'starter',
    });

    expect(result.isNew).toBe(true);
    expect(result.organizationId).toBe('org_new_1');
    expect(result.organizationName).toBe('Acme Corp');
    expect(result.membershipId).toBe('mem_new_1');

    // Verify Organization creation params
    expect(mockTx.organization.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Acme Corp',
          type: 'USER',
          homeJurisdictionCode: 'KEN',
          enabledJurisdictions: ['KEN'],
          users: { connect: { id: 'user_1' } },
        }),
      })
    );

    // Verify User update
    expect(mockTx.user.update).toHaveBeenCalledWith({
      where: { id: 'user_1' },
      data: { organizationId: 'org_new_1' },
    });

    // Verify OrganizationMember creation params
    expect(mockTx.organizationMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user_1',
          organizationId: 'org_new_1',
          role: MemberRole.OWNER,
          status: MemberStatus.ACTIVE,
        }),
      })
    );
  });

  it('provisions with fallback name when companyName is not provided', async () => {
    const mockTx = {
      organization: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'org_new_2',
          name: "Jane's Workspace",
        }),
      },
      organizationMember: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'mem_new_2',
        }),
      },
      user: {
        update: vi.fn().mockResolvedValue({
          id: 'user_2',
          organizationId: 'org_new_2',
        }),
      },
    };

    const result = await provisionDefaultOrganization(mockTx as any, {
      user: {
        id: 'user_2',
        email: 'jane@example.com',
        fullName: 'Jane Doe',
        role: 'STARTUP',
        organizationId: null,
      },
      companyName: null,
    });

    expect(result.isNew).toBe(true);
    expect(result.organizationName).toBe("Jane's Workspace");
  });

  it('reuses existing active membership if User.organizationId is desynced', async () => {
    const mockTx = {
      organization: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      organizationMember: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'mem_existing',
          organization: {
            id: 'org_existing_3',
            name: 'Existing Org',
          },
        }),
      },
      user: {
        update: vi.fn().mockResolvedValue({
          id: 'user_3',
          organizationId: 'org_existing_3',
        }),
      },
    };

    const result = await provisionDefaultOrganization(mockTx as any, {
      user: {
        id: 'user_3',
        email: 'bob@example.com',
        fullName: 'Bob Smith',
        role: 'USER',
        organizationId: null,
      },
    });

    expect(result.isNew).toBe(false);
    expect(result.organizationId).toBe('org_existing_3');
    expect(result.organizationName).toBe('Existing Org');
    expect(mockTx.user.update).toHaveBeenCalledWith({
      where: { id: 'user_3' },
      data: { organizationId: 'org_existing_3' },
    });
  });
});
