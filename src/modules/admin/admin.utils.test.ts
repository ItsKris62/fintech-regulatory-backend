import { describe, expect, it } from 'vitest';
import { toAdminOrgDetail, toAdminUserDetail } from './admin.utils';

describe('admin utils', () => {
  it('maps organization members and canonical plan details', () => {
    const createdAt = new Date('2026-01-10T00:00:00.000Z');
    const detail = toAdminOrgDetail(
      {
        id: 'org_1',
        name: 'Acme Holdings',
        type: 'company',
        organizationType: 'enterprise',
        registrationNumber: 'REG-42',
        cbkLicenseNumber: 'CBK-77',
        website: 'https://acme.test',
        industry: 'Fintech',
        size: '51-200',
        verificationStatus: 'verified',
        address: 'Nairobi',
        contactPerson: 'Jane Doe',
        contactPosition: 'Compliance Lead',
        contactEmail: 'jane@acme.test',
        contactPhone: '+254700000000',
        subscriptionTier: 'starter',
        plan: 'ENTERPRISE',
        subscriptionStatus: 'ACTIVE',
        trialEndsAt: null,
        gracePeriodEndsAt: null,
        cancelledAt: null,
        subscriptionEndsAt: null,
        planStartDate: createdAt,
        planEndDate: null,
        maxSeats: 75,
        createdAt,
        updatedAt: createdAt,
        users: [
          {
            id: 'user_1',
            fullName: 'Jane Doe',
            email: 'jane@acme.test',
            role: 'ENTERPRISE',
            status: 'ACTIVE',
            createdAt,
          },
        ],
      },
      { members: 1, documents: 4, policies: 2 }
    );

    expect(detail.plan).toBe('ENTERPRISE');
    expect(detail.subscriptionTier).toBe('ENTERPRISE');
    expect(detail.organizationType).toBe('enterprise');
    expect(detail.contactEmail).toBe('jane@acme.test');
    expect(detail.users).toHaveLength(1);
    expect(detail.users[0]?.email).toBe('jane@acme.test');
  });

  it('normalizes legacy organization plans on user detail output', () => {
    const detail = toAdminUserDetail(
      {
        id: 'user_1',
        email: 'founder@example.com',
        fullName: 'Founder',
        phone: null,
        role: 'STARTUP',
        status: 'ACTIVE',
        emailVerified: true,
        organizationId: 'org_1',
        organization: {
          name: 'Launchpad',
          subscriptionTier: 'professional',
        },
        lastLoginAt: null,
        lastLoginIp: null,
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        updatedAt: new Date('2026-02-01T00:00:00.000Z'),
      },
      { sessions: 0, policies: 0, queries: 0 }
    );

    expect(detail.organizationPlan).toBe('BUSINESS');
  });
});