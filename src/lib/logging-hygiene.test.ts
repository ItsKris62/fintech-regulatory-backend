import { vi, describe, expect, it, beforeEach } from 'vitest';

// Mock tRPC init.ts so that middleware returns the plain inner function for direct unit testing.
vi.mock('../server/trpc/init', () => {
  return {
    middleware: (fn: any) => fn,
    router: {},
    baseProcedure: {},
  };
});

import { loggedMiddlewareHandler } from '../server/trpc/middleware';
import { logger } from '../utils/logger';
import { TRPCError } from '@trpc/server';

describe('tRPC logged middleware hygiene', () => {
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
  const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs BAD_REQUEST (client-side error) as warn', async () => {
    const error = new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid input parameters' });
    const next = vi.fn().mockResolvedValue({ ok: false, error });
    await loggedMiddlewareHandler({
      ctx: { req: { ip: '127.0.0.1' }, user: null },
      path: 'test.proc',
      type: 'query',
      next,
    } as any);

    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs UNAUTHORIZED (client-side error) as warn', async () => {
    const error = new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid credentials' });
    const next = vi.fn().mockResolvedValue({ ok: false, error });
    await loggedMiddlewareHandler({
      ctx: { req: { ip: '127.0.0.1' }, user: null },
      path: 'test.proc',
      type: 'mutation',
      next,
    } as any);

    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs INTERNAL_SERVER_ERROR (server-side error) as error', async () => {
    const error = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database connection failed' });
    const next = vi.fn().mockResolvedValue({ ok: false, error });
    await loggedMiddlewareHandler({
      ctx: { req: { ip: '127.0.0.1' }, user: null },
      path: 'test.proc',
      type: 'query',
      next,
    } as any);

    expect(errorSpy).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
