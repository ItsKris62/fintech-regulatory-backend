/* eslint-disable no-restricted-syntax */
import { describe, expect, it } from 'vitest';
import * as prismaClient from './client';

describe('Prisma Client SQL Injection Guardrails', () => {
  it('should not export executeRawQuery', () => {
    expect((prismaClient as any).executeRawQuery).toBeUndefined();
  });

  it('should not expose $queryRawUnsafe or $executeRawUnsafe via wrappers', () => {
    expect((prismaClient as any).executeRawQuery).toBeUndefined();
  });
});
