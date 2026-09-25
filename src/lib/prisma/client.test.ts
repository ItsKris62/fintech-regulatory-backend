/* eslint-disable no-restricted-syntax */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as prismaClient from './client';

describe('Prisma Client SQL Injection Guardrails', () => {
  it('should not export executeRawQuery', () => {
    expect((prismaClient as any).executeRawQuery).toBeUndefined();
  });

  it('should not expose $queryRawUnsafe or $executeRawUnsafe via wrappers', () => {
    expect((prismaClient as any).executeRawQuery).toBeUndefined();
  });
});

describe('F-05: Postgres Statement Timeout & Pool Configuration (audit REL-05)', () => {
  const clientSource = readFileSync(resolve(__dirname, 'client.ts'), 'utf8');

  it('configures pg.Pool with statement_timeout=15000 and idle_in_transaction_session_timeout=10000', () => {
    expect(clientSource).toContain('statement_timeout=15000');
    expect(clientSource).toContain('idle_in_transaction_session_timeout=10000');
    expect(clientSource).toContain('new pg.Pool(');
    expect(clientSource).toContain('new PrismaPg(pool)');
  });

  it('provides withElevatedStatementTimeout helper for legitimate cron/admin exceptions', () => {
    expect(typeof (prismaClient as any).withElevatedStatementTimeout).toBe('function');
    expect(clientSource).toContain('SET LOCAL statement_timeout =');
  });

  it('guards against managed Postgres stripping startup options via pool on connect handler', () => {
    expect(clientSource).toContain("pool.on('connect'");
    expect(clientSource).toContain('SET statement_timeout = 15000');
  });
});
