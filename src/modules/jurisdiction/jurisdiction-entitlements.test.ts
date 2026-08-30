import { describe, expect, it, vi } from 'vitest';
import {
  JURISDICTION_AUTH_ERROR,
  JurisdictionAuthorizationError,
  resolveJurisdictionEntitlement,
} from './jurisdiction-entitlements';

function prismaForHome(homeJurisdictionCode: string | null) {
  return {
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'org-1',
        homeJurisdictionCode,
      }),
    },
  } as any;
}

describe('resolveJurisdictionEntitlement', () => {
  it('allows a restricted REGULATOR user to query their home jurisdiction', async () => {
    const result = await resolveJurisdictionEntitlement({
      prisma: prismaForHome('KE'),
      organizationId: 'org-1',
      effectivePlan: 'REGULATOR',
      requestedMode: 'SINGLE',
      requestedJurisdictions: ['KE'],
    });

    expect(result.homeJurisdiction).toBe('KE');
    expect(result.allowedJurisdictions).toEqual(['KE']);
    expect(result.requestedJurisdictions).toEqual(['KE']);
    expect(result.mode).toBe('SINGLE');
  });

  it('denies a restricted REGULATOR user requesting a foreign jurisdiction', async () => {
    await expect(resolveJurisdictionEntitlement({
      prisma: prismaForHome('KE'),
      organizationId: 'org-1',
      effectivePlan: 'REGULATOR',
      requestedMode: 'SINGLE',
      requestedJurisdictions: ['RW'],
    })).rejects.toMatchObject({
      code: JURISDICTION_AUTH_ERROR.JURISDICTION_NOT_ENTITLED,
      statusCode: 403,
    });
  });

  it('denies comparison mode while the release gate is disabled', async () => {
    await expect(resolveJurisdictionEntitlement({
      prisma: prismaForHome('KE'),
      organizationId: 'org-1',
      effectivePlan: 'FREE_TRIAL',
      requestedMode: 'COMPARE',
      requestedJurisdictions: ['KE', 'RW'],
    })).rejects.toMatchObject({
      code: 'COMPARE_MODE_DISABLED',
    });
  });

  it('fails closed when organization home jurisdiction has not been assigned', async () => {
    await expect(resolveJurisdictionEntitlement({
      prisma: prismaForHome(null),
      organizationId: 'org-1',
      effectivePlan: 'STARTUP',
      requestedMode: 'SINGLE',
      requestedJurisdictions: ['KE'],
    })).rejects.toBeInstanceOf(JurisdictionAuthorizationError);
  });

  it('enforces the complete home-country-only matrix before downstream calls', async () => {
    const countries = ['KE', 'RW', 'MW', 'NG'] as const;
    for (const home of countries) {
      for (const requested of countries) {
        const operation = resolveJurisdictionEntitlement({
          prisma: prismaForHome(home),
          organizationId: 'org-1',
          effectivePlan: 'FREE_TRIAL',
          requestedMode: 'SINGLE',
          requestedJurisdictions: [requested],
        });
        if (requested === home) {
          await expect(operation).resolves.toMatchObject({ homeJurisdiction: home, requestedJurisdictions: [home] });
        } else {
          await expect(operation).rejects.toMatchObject({
            code: JURISDICTION_AUTH_ERROR.JURISDICTION_NOT_ENTITLED,
            statusCode: 403,
          });
        }
      }
    }
  });

  it('allows an existing multi-country entitlement to request Nigeria', async () => {
    await expect(resolveJurisdictionEntitlement({
      prisma: prismaForHome('KE'),
      organizationId: 'org-1',
      effectivePlan: 'STARTUP',
      requestedMode: 'SINGLE',
      requestedJurisdictions: ['NG'],
    })).resolves.toMatchObject({ requestedJurisdictions: ['NG'] });
  });

  it('rejects malformed SINGLE and COMPARE requests before downstream calls', async () => {
    const pineconeSearch = vi.fn();
    const anthropicCall = vi.fn();

    await expect(resolveJurisdictionEntitlement({
      prisma: prismaForHome('KE'),
      organizationId: 'org-1',
      effectivePlan: 'STARTUP',
      requestedMode: 'SINGLE',
      requestedJurisdictions: ['KE', 'RW'],
    })).rejects.toMatchObject({ code: 'JURISDICTION_REQUIRED' });

    await expect(resolveJurisdictionEntitlement({
      prisma: prismaForHome('KE'),
      organizationId: 'org-1',
      effectivePlan: 'STARTUP',
      requestedMode: 'COMPARE',
      requestedJurisdictions: ['KE'],
    })).rejects.toMatchObject({ code: 'COMPARE_MODE_DISABLED' });

    expect(pineconeSearch).not.toHaveBeenCalled();
    expect(anthropicCall).not.toHaveBeenCalled();
  });
});
