import { describe, expect, it, vi } from 'vitest';
import {
  createTenantScopedPrisma,
  TENANT_MODEL_FIELD_MAP,
} from './tenant-scope.extension';

describe('F-03: Prisma Automatic Tenant Scoping Extension', () => {
  it('enumerates all 39 tenant-scoped models in schema.prisma', () => {
    const models = Object.keys(TENANT_MODEL_FIELD_MAP);
    expect(models.length).toBe(39);
    expect(TENANT_MODEL_FIELD_MAP.LegalDocument).toBe('organizationId');
    expect(TENANT_MODEL_FIELD_MAP.Payment).toBe('orgId');
    expect(TENANT_MODEL_FIELD_MAP.VaultDocument).toBe('organizationId');
    expect(TENANT_MODEL_FIELD_MAP.AnalyticsEvent).toBe('orgId');
  });

  it('throws a clear error when orgId is absent from tenancy context', async () => {
    const mockPrisma = {
      $extends: vi.fn().mockImplementation((config) => {
        // simulate extension execution
        const handler = config.query.$allModels.$allOperations;
        return {
          legalDocument: {
            findMany: (args: any) =>
              handler({ model: 'LegalDocument', operation: 'findMany', args, query: vi.fn() }),
          },
        };
      }),
    };

    const scoped = createTenantScopedPrisma(mockPrisma as any, undefined);

    await expect(scoped.legalDocument.findMany({})).rejects.toThrowError(
      /Tenant context error: orgId is missing from context for tenant-scoped model "LegalDocument"/
    );
  });

  it('asserts a request scoped to Org A cannot read Org B Document (LegalDocument), Payment, and VaultItem (VaultDocument) rows even when the query omits where', async () => {
    let capturedLegalDocArgs: any = null;
    let capturedPaymentArgs: any = null;
    let capturedVaultDocArgs: any = null;

    const mockPrisma: any = {
      $extends: vi.fn().mockImplementation((config) => {
        const handler = config.query.$allModels.$allOperations;
        return {
          legalDocument: {
            findMany: (args: any) =>
              handler({
                model: 'LegalDocument',
                operation: 'findMany',
                args,
                query: async (finalArgs: any) => {
                  capturedLegalDocArgs = finalArgs;
                  // Simulate DB query filtered by finalArgs.where
                  const allRows = [
                    { id: 'doc-1', title: 'Org A Policy Doc', organizationId: 'org-A' },
                    { id: 'doc-2', title: 'Org B Secret Doc', organizationId: 'org-B' },
                  ];
                  return allRows.filter((r) => r.organizationId === finalArgs.where.organizationId);
                },
              }),
          },
          payment: {
            findMany: (args: any) =>
              handler({
                model: 'Payment',
                operation: 'findMany',
                args,
                query: async (finalArgs: any) => {
                  capturedPaymentArgs = finalArgs;
                  const allRows = [
                    { id: 'pay-1', amount: 500, orgId: 'org-A' },
                    { id: 'pay-2', amount: 9999, orgId: 'org-B' },
                  ];
                  return allRows.filter((r) => r.orgId === finalArgs.where.orgId);
                },
              }),
          },
          vaultDocument: {
            findMany: (args: any) =>
              handler({
                model: 'VaultDocument',
                operation: 'findMany',
                args,
                query: async (finalArgs: any) => {
                  capturedVaultDocArgs = finalArgs;
                  const allRows = [
                    { id: 'vault-1', name: 'Org A License Vault', organizationId: 'org-A' },
                    { id: 'vault-2', name: 'Org B Proprietary Vault', organizationId: 'org-B' },
                  ];
                  return allRows.filter((r) => r.organizationId === finalArgs.where.organizationId);
                },
              }),
          },
        };
      }),
    };

    const clientOrgA = createTenantScopedPrisma(mockPrisma, 'org-A');

    // 1. LegalDocument query omits where: { organizationId }
    const docResults = await clientOrgA.legalDocument.findMany({});
    expect(capturedLegalDocArgs.where).toEqual({ organizationId: 'org-A' });
    expect(docResults).toEqual([
      { id: 'doc-1', title: 'Org A Policy Doc', organizationId: 'org-A' },
    ]);
    expect(docResults.some((d: any) => d.organizationId === 'org-B')).toBe(false);

    // 2. Payment query omits where: { orgId }
    const payResults = await clientOrgA.payment.findMany({});
    expect(capturedPaymentArgs.where).toEqual({ orgId: 'org-A' });
    expect(payResults).toEqual([{ id: 'pay-1', amount: 500, orgId: 'org-A' }]);
    expect(payResults.some((p: any) => p.orgId === 'org-B')).toBe(false);

    // 3. VaultDocument query omits where: { organizationId }
    const vaultResults = await clientOrgA.vaultDocument.findMany({});
    expect(capturedVaultDocArgs.where).toEqual({ organizationId: 'org-A' });
    expect(vaultResults).toEqual([
      { id: 'vault-1', name: 'Org A License Vault', organizationId: 'org-A' },
    ]);
    expect(vaultResults.some((v: any) => v.organizationId === 'org-B')).toBe(false);
  });

  it('injects tenant orgId into create and createMany mutations', async () => {
    let capturedCreateArgs: any = null;
    let capturedCreateManyArgs: any = null;

    const mockPrisma: any = {
      $extends: vi.fn().mockImplementation((config) => {
        const handler = config.query.$allModels.$allOperations;
        return {
          legalDocument: {
            create: (args: any) =>
              handler({
                model: 'LegalDocument',
                operation: 'create',
                args,
                query: async (finalArgs: any) => {
                  capturedCreateArgs = finalArgs;
                  return { id: 'new-doc', ...finalArgs.data };
                },
              }),
            createMany: (args: any) =>
              handler({
                model: 'LegalDocument',
                operation: 'createMany',
                args,
                query: async (finalArgs: any) => {
                  capturedCreateManyArgs = finalArgs;
                  return { count: finalArgs.data.length };
                },
              }),
          },
        };
      }),
    };

    const clientOrgA = createTenantScopedPrisma(mockPrisma, 'org-A');

    await clientOrgA.legalDocument.create({
      data: { title: 'New Compliance Policy' },
    });
    expect(capturedCreateArgs.data).toEqual({
      title: 'New Compliance Policy',
      organizationId: 'org-A',
    });

    await clientOrgA.legalDocument.createMany({
      data: [{ title: 'Doc 1' }, { title: 'Doc 2' }],
    });
    expect(capturedCreateManyArgs.data).toEqual([
      { title: 'Doc 1', organizationId: 'org-A' },
      { title: 'Doc 2', organizationId: 'org-A' },
    ]);
  });

  it('preserves untouched execution for non-tenant models (e.g., SystemConfig)', async () => {
    let capturedArgs: any = null;

    const mockPrisma: any = {
      $extends: vi.fn().mockImplementation((config) => {
        const handler = config.query.$allModels.$allOperations;
        return {
          systemConfig: {
            findMany: (args: any) =>
              handler({
                model: 'SystemConfig',
                operation: 'findMany',
                args,
                query: async (finalArgs: any) => {
                  capturedArgs = finalArgs;
                  return [{ key: 'maintenance_mode', value: 'false' }];
                },
              }),
          },
        };
      }),
    };

    const clientOrgA = createTenantScopedPrisma(mockPrisma, 'org-A');
    const result = await clientOrgA.systemConfig.findMany({ where: { key: 'maintenance_mode' } });

    expect(capturedArgs.where).toEqual({ key: 'maintenance_mode' });
    expect(capturedArgs.where.organizationId).toBeUndefined();
    expect(capturedArgs.where.orgId).toBeUndefined();
    expect(result).toHaveLength(1);
  });
});
