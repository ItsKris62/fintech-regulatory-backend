import { TRPCError } from '@trpc/server';
import { middleware } from './init';
import { rateLimiter } from '@/lib/redis/rate-limiter';
import { logger } from '@/utils/logger';

/**
 * Logging Middleware (Fixed Error Handling)
 * tRPC intercepts procedure errors, so we must check `result.ok` 
 * instead of relying on a try/catch block.
 */
export const logged = middleware(async ({ ctx, path, type, next }) => {
  const start = Date.now();
  
  logger.info({
    type: 'trpc_request_start',
    path,
    requestType: type,
    userId: ctx.user?.id || 'anonymous',
    ip: ctx.req.ip,
  });

  const result = await next({ ctx });
  const duration = Date.now() - start;

  if (result.ok) {
    logger.info({
      type: 'trpc_request_success',
      path,
      requestType: type,
      userId: ctx.user?.id,
      duration,
    });
  } else {
    logger.error({
      type: 'trpc_request_error',
      path,
      requestType: type,
      userId: ctx.user?.id,
      error: result.error.message,
      code: result.error.code,
      duration,
    });
  }

  return result;
});

/**
 * Authentication Middleware
 */
export const isAuthenticated = middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required. Please log in.',
    });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user, // TypeScript now infers user as NonNullable downstream
    },
  });
});

/**
 * Role-based Middlewares
 */
export const isAdmin = middleware(async ({ ctx, next }) => {
  if (!ctx.user || ctx.user.role !== 'ADMIN') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
  }
  return next({ ctx });
});

export const isRegulator = middleware(async ({ ctx, next }) => {
  if (!ctx.user || ctx.user.role !== 'REGULATOR') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Regulator access required' });
  }
  return next({ ctx });
});

export const isStartup = middleware(async ({ ctx, next }) => {
  if (!ctx.user || ctx.user.role !== 'STARTUP') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Startup access required' });
  }
  return next({ ctx });
});

export const isEnterprise = middleware(async ({ ctx, next }) => {
  if (!ctx.user || ctx.user.role !== 'ENTERPRISE') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Enterprise access required' });
  }
  return next({ ctx });
});

/**
 * Rate Limiting Middleware
 */
export const rateLimited = (action: string, maxRequests?: number) =>
  middleware(async ({ ctx, next }) => {
    // Fallback securely if Fastify IP is missing for some reason
    const identifier = ctx.user?.id || ctx.req.ip || 'anonymous';

    try {
      await rateLimiter.checkOrThrow(identifier, action, maxRequests ?? 100, 900);
    } catch (error: unknown) {
      logger.warn({
        type: 'rate_limit_exceeded',
        action,
        identifier,
        userId: ctx.user?.id,
      });

      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Rate limit exceeded. Please try again later.',
      });
    }

    return next({ ctx });
  });

/**
 * Organization Member Middleware (Fixed Type Safety)
 * Avoids `as any` by safely checking if the input is an object with an organizationId.
 */
export const isOrganizationMember = middleware(async ({ ctx, input, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  }

  // Type-safe way to check input without using `any`
  const hasOrgId = input && typeof input === 'object' && 'organizationId' in input;
  const organizationId = hasOrgId ? (input as { organizationId: string }).organizationId : null;
  
  if (!organizationId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Organization ID is required in the request payload',
    });
  }

  // Allow admins to bypass this check
  if (ctx.user.organizationId !== organizationId && ctx.user.role !== 'ADMIN') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Access denied to this organization',
    });
  }

  return next({ ctx });
});