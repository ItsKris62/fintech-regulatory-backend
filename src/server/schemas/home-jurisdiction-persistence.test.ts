import { describe, expect, it } from 'vitest';
import { registerSchema } from './auth.schema';
import { createOrganizationSchema } from './organization.schema';
import { createUserWithOrganizationInputSchema } from '../services/userProvisioning.service';

const jurisdictions = ['KE', 'RW', 'MW', 'NG'] as const;

describe('new organization home jurisdiction contract', () => {
  it.each(jurisdictions)('accepts and retains %s in direct organization creation', (homeJurisdictionCode) => {
    expect(createOrganizationSchema.parse({
      name: 'Regulatory Org', type: 'STARTUP', contactEmail: 'owner@example.com', homeJurisdictionCode,
    })).toMatchObject({ homeJurisdictionCode });
  });

  it.each(jurisdictions)('accepts and retains %s in public registration', (homeJurisdictionCode) => {
    const parsed = registerSchema.parse({
      email: `${homeJurisdictionCode.toLowerCase()}@example.com`,
      password: 'Str0ngPassw0rd!',
      name: 'QA Owner',
      role: 'STARTUP',
      companyName: `${homeJurisdictionCode} QA Org`,
      homeJurisdictionCode,
    });
    expect(parsed.homeJurisdictionCode).toBe(homeJurisdictionCode);
  });

  it.each(jurisdictions)('accepts and retains %s in pilot provisioning', (homeJurisdictionCode) => {
    const parsed = createUserWithOrganizationInputSchema.parse({
      email: `${homeJurisdictionCode.toLowerCase()}-pilot@example.com`,
      fullName: 'QA Pilot',
      isPilot: true,
      organizationName: `${homeJurisdictionCode} Pilot Org`,
      homeJurisdictionCode,
      supabaseAuthId: 'auth-id',
      adminId: 'admin-id',
      requestId: 'request-id',
    });
    expect(parsed.homeJurisdictionCode).toBe(homeJurisdictionCode);
  });

  it('rejects missing jurisdiction for every organization-creating path', () => {
    expect(() => createOrganizationSchema.parse({
      name: 'Missing Home', type: 'STARTUP', contactEmail: 'owner@example.com',
    })).toThrow();
    expect(() => registerSchema.parse({
      email: 'owner@example.com', password: 'Str0ngPassw0rd!', name: 'Owner', role: 'STARTUP', companyName: 'Missing Home',
    })).toThrow();
    expect(() => createUserWithOrganizationInputSchema.parse({
      email: 'pilot@example.com', fullName: 'Pilot', isPilot: true, organizationName: 'Missing Home',
      supabaseAuthId: 'auth-id', adminId: 'admin-id', requestId: 'request-id',
    })).toThrow();
  });
});
