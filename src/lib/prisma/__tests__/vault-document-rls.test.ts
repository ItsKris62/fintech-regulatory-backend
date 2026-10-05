import { describe, it, expect, vi } from 'vitest';
import {
  withTenantRlsTransaction,
  withBypassRlsTransaction,
} from '../tenant-scope.extension';

describe('Postgres RLS Pilot on VaultDocument (SEC-12 / Option A)', () => {
  it('exports withTenantRlsTransaction and withBypassRlsTransaction helpers', () => {
    expect(typeof withTenantRlsTransaction).toBe('function');
    expect(typeof withBypassRlsTransaction).toBe('function');
  });

  it('sets app.current_org_id locally inside interactive transaction and isolates tenant', async () => {
    const executedQueries: any[] = [];
    const mockTx = {
      $executeRaw: vi.fn(async (...args: any[]) => {
        executedQueries.push(args);
        return 1;
      }),
      vaultDocument: {
        findMany: vi.fn(async () => [
          { id: 'doc-1', organizationId: 'org-tenant-a', title: 'Doc A' },
        ]),
      },
    };

    const mockPrisma = {
      $transaction: vi.fn(async (callback: (tx: any) => Promise<any>) => {
        return callback(mockTx);
      }),
    };

    const result = await withTenantRlsTransaction(mockPrisma as any, 'org-tenant-a', async (tx) => {
      return tx.vaultDocument.findMany();
    });

    expect(result).toHaveLength(1);
    expect(mockTx.$executeRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("set_config('app.current_org_id'")]),
      'org-tenant-a',
    );
  });

  it('sets app.bypass_rls = true locally inside bypass transaction for cron jobs', async () => {
    const mockTx = {
      $executeRaw: vi.fn(async () => 1),
      vaultDocument: {
        findMany: vi.fn(async () => [
          { id: 'doc-1', organizationId: 'org-tenant-a' },
          { id: 'doc-2', organizationId: 'org-tenant-b' },
        ]),
      },
    };

    const mockPrisma = {
      $transaction: vi.fn(async (callback: (tx: any) => Promise<any>) => {
        return callback(mockTx);
      }),
    };

    const result = await withBypassRlsTransaction(mockPrisma as any, async (tx) => {
      return tx.vaultDocument.findMany();
    });

    expect(result).toHaveLength(2);
    expect(mockTx.$executeRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("set_config('app.bypass_rls', 'true', true)")]),
    );
  });

  it('enforces SET LOCAL is_local=true to prevent connection pool leakage', async () => {
    const executedSql: any[] = [];
    const mockTx = {
      $executeRaw: vi.fn(async (...args: any[]) => {
        executedSql.push(args);
        return 1;
      }),
      vaultDocument: {
        findFirst: vi.fn(async () => ({ id: 'doc-1' })),
      },
    };

    const mockPrisma = {
      $transaction: vi.fn(async (callback: (tx: any) => Promise<any>) => {
        return callback(mockTx);
      }),
    };

    await withTenantRlsTransaction(mockPrisma as any, 'org-pool-test', async (tx) => {
      return tx.vaultDocument.findFirst();
    });

    // The third parameter to set_config MUST be true (is_local = true)
    // so PostgreSQL automatically clears it upon COMMIT/ROLLBACK without leaking to pooled connections
    expect(mockTx.$executeRaw).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.stringContaining("SELECT set_config('app.current_org_id'"),
        expect.stringContaining(", true)"),
      ]),
      'org-pool-test',
    );
  });
});
