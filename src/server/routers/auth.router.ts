import { TRPCError } from '@trpc/server';
import { createHash, randomBytes } from 'crypto';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { router, publicProcedure, protectedProcedure } from '../trpc/trpc';
import {
  registerSchema,
  loginSchema,
  resetPasswordRequestSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  refreshTokenSchema,
} from '../schemas/auth.schema';

import { appConfig } from '@/config/app.config';
import { redis } from '@/lib/redis/client';
import { hashPassword } from '@/utils/helpers';
import { authRateLimiter, rateLimiter } from '@/lib/redis/rate-limiter';
import { logger } from '@/utils/logger';
import { hashIp, revokedBearerTokenKey } from '@/utils/request-identifiers';
import { supabaseAdmin, supabaseClient } from '@/lib/supabase';
import { SESSION_CONFIG, lastSeenKey, sessionStartKey } from '@/config/session';
import { revokedJtiKey, revokeAllUserTokens } from '@/utils/token-revocation';
import { extractExp, extractJti } from '@/utils/jwt';
import { loadSystemConfig } from '@/lib/system-config';
import { subscriptionTierToPlanOrFree } from '@/utils/plan-mapping';

import {
  isFreeEmailDomain,
  FREE_EMAIL_ERROR_MESSAGE,
  isRegulatorDomain,
  findValidInvitation,
  consumeInvitation,
  initializeNotificationPreferences,
} from '@/lib/verification/verification.service';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { validatePassword } from '@/shared/validation/password.schema';
import {
  AUTH_ERROR_CODES,
  getAuthErrorMessage,
} from '@/shared/errors/auth-error-messages';

// -- helpers ---------------------------------------------------------------

function generateVerificationToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Mask an email for structured logging  -  never log full addresses.
 * e.g. "kamau@equity.co.ke" -> "k***@equity.co.ke"
 */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***@***';
  return `${local[0]}***@${domain}`;
}

function parseDeviceLabel(userAgent: string | undefined): string {
  if (!userAgent) return 'Unknown Device';
  if (/iPhone|iPad/.test(userAgent)) return 'iOS Device';
  if (/Android/.test(userAgent)) return 'Android Device';
  if (/Windows/.test(userAgent)) return 'Windows Browser';
  if (/Mac OS/.test(userAgent)) return 'macOS Browser';
  if (/Linux/.test(userAgent)) return 'Linux Browser';
  return 'Unknown Device';
}

function resolveSessionTimeoutSeconds(sessionTimeoutHours: unknown): number {
  const hours = Number(sessionTimeoutHours);
  const fallbackHours = SESSION_CONFIG.ABSOLUTE_TIMEOUT_SECONDS / 3600;
  const resolvedHours = Number.isFinite(hours) && hours > 0 ? hours : fallbackHours;
  return Math.round(Math.min(Math.max(resolvedHours, 1), 720) * 3600);
}

/**
 * Enforce a rate limit result  -  throws TRPCError(TOO_MANY_REQUESTS) when
 * the limit is exceeded so the router's existing catch blocks handle it cleanly.
 */
function enforceRateLimit(
  result: { allowed: boolean; retryAfter?: number },
  message = 'Too many requests. Please try again later.'
): void {
  if (!result.allowed) {
    const suffix = result.retryAfter ? ` Try again in ${result.retryAfter} seconds.` : '';
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: message + suffix });
  }
}

async function enforcePublicTokenRateLimit(
  ip: string | undefined,
  action: string,
  maxRequests: number,
  message: string,
): Promise<void> {
  const rlResult = await rateLimiter.check(hashIp(ip), action, maxRequests, 900, { failClosed: true });
  enforceRateLimit(rlResult, message);
}

async function revokeLogoutBearerTokenStrict(token: string): Promise<void> {
  const jti = extractJti(token);
  const exp = extractExp(token);
  const ttlSeconds = exp
    ? Math.min(Math.max(exp - Math.floor(Date.now() / 1000), 1), 7200)
    : 3600;

  const key = jti ? revokedJtiKey(jti) : revokedBearerTokenKey(token);
  await redis.set(key, 'logout', { ex: ttlSeconds });
  logger.info({
    type: 'auth_logout_token_revoked',
    tokenRef: jti ?? 'token_hash',
    ttlSeconds,
  });
}

// -- router ----------------------------------------------------------------

export const authRouter = router({
  /**
   * Register  -  creates a Supabase auth user AND a Prisma user profile.
   * If Prisma creation fails, the Supabase user is deleted as a compensating
   * transaction so no orphaned auth records are left behind.
   */
  register: publicProcedure
    .input(registerSchema)
    .mutation(async ({ input, ctx }) => {
      const startTime = Date.now();

      try {
        // Rate limiting
        const rlResult = await authRateLimiter.register(input.email);
        enforceRateLimit(rlResult, getAuthErrorMessage(AUTH_ERROR_CODES.RATE_LIMITED_REGISTER));

        logger.info({ type: 'auth_register_attempt', email: maskEmail(input.email), role: input.role });

        const systemConfig = await loadSystemConfig();
        const requireEmailVerification = systemConfig.requireEmailVerification !== false;

        // -- Password policy enforcement (before any DB lookups) ----------
        const pwValidation = validatePassword(input.password, input.email, {
          minLength: Number(systemConfig.passwordMinLength ?? 10),
        });
        if (!pwValidation.isValid) {
          if (!pwValidation.rules.notCommon) {
            logger.warn({
              type: 'auth_register_common_password_attempt',
              email: maskEmail(input.email),
            });
          }
          throw new TRPCError({ code: 'BAD_REQUEST', message: pwValidation.errors[0] });
        }

        const existingUser = await ctx.prisma.user.findUnique({
          where: { email: input.email },
          select: { emailVerified: true, accountStatus: true },
        });
        // SECURITY: Never reveal whether a specific email is already registered.
        // Return the same message regardless of whether the account exists.
        if (existingUser) {
          logger.info({ type: 'auth_register_email_exists', email: maskEmail(input.email) });
          throw new TRPCError({
            code: 'CONFLICT',
            message: getAuthErrorMessage(AUTH_ERROR_CODES.EMAIL_UNAVAILABLE),
          });
        }

        const invitation = await findValidInvitation(input.email);

        if (!systemConfig.allowNewRegistrations && !invitation) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'New registrations are temporarily closed. Please contact support.',
          });
        }

        if (input.role !== 'REGULATOR' && isFreeEmailDomain(input.email)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: FREE_EMAIL_ERROR_MESSAGE });
        }

        if (input.role === 'REGULATOR' && !invitation) {
          const domainCheck = await isRegulatorDomain(input.email);
          if (!domainCheck.isRegulator) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Regulator accounts require a verified government email address.',
            });
          }
        }

        if (input.organizationId) {
          const org = await ctx.prisma.organization.findUnique({ where: { id: input.organizationId } });
          if (!org) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid organization ID' });
        }

        const resolvedRole = invitation
          ? (invitation.role as 'REGULATOR' | 'STARTUP' | 'ENTERPRISE')
          : input.role;

        // Create Supabase auth user. When verification is required, generate a
        // native OTP link so our React Email template can deliver it.
        const appCallbackUrl = process.env.APP_CALLBACK_URL || 'https://sheriabot.com/auth/callback';
        let supabaseUserId: string;
        let verificationUrl: string | null = null;

        if (requireEmailVerification) {
          const { data: authData, error: authError } = await supabaseAdmin.auth.admin.generateLink({
            type: 'signup',
            email: input.email,
            password: input.password,
            options: {
              redirectTo: appCallbackUrl,
              data: { role: resolvedRole, fullName: input.name || input.email },
            },
          });

          if (authError || !authData?.user || !authData?.properties?.action_link) {
            logger.error({
              type: 'auth_register_supabase_error',
              email: maskEmail(input.email),
              supabaseCode: authError?.code ?? 'unknown',
            });
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: getAuthErrorMessage(AUTH_ERROR_CODES.REGISTRATION_FAILED),
            });
          }

          supabaseUserId = authData.user.id;
          verificationUrl = authData.properties.action_link;
        } else {
          const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email: input.email,
            password: input.password,
            email_confirm: true,
            user_metadata: { role: resolvedRole, fullName: input.name || input.email },
          });

          if (authError || !authData?.user) {
            logger.error({
              type: 'auth_register_supabase_error',
              email: maskEmail(input.email),
              supabaseCode: authError?.code ?? 'unknown',
            });
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: getAuthErrorMessage(AUTH_ERROR_CODES.REGISTRATION_FAILED),
            });
          }

          supabaseUserId = authData.user.id;
        }

        // F3.2b  -  if Prisma creation fails, delete the Supabase user so there
        // are no orphaned auth records that block re-registration.
        let user: any;
        const initialAccountStatus = requireEmailVerification
          ? 'pending'
          : resolvedRole === 'REGULATOR'
            ? 'pending_approval'
            : 'active';
        try {
          user = await ctx.prisma.user.create({
            data: {
              supabaseAuthId: supabaseUserId,
              email: input.email,
              fullName: input.name || input.email,
              role: resolvedRole,
              phone: input.phone,
              organizationId: invitation?.organizationId || input.organizationId,
              emailVerified: !requireEmailVerification,
              emailVerifiedAt: requireEmailVerification ? null : new Date(),
              status: requireEmailVerification ? 'PENDING_VERIFICATION' : 'ACTIVE',
              accountStatus: initialAccountStatus,
            } as any,
            select: { id: true, email: true, fullName: true, role: true, organizationId: true, createdAt: true },
          });
        } catch (prismaErr: any) {
          logger.error({
            type: 'auth_register_prisma_error',
            email: input.email,
            error: prismaErr.message,
          });
          // Compensating transaction: remove the Supabase user to keep systems consistent
          await supabaseAdmin.auth.admin.deleteUser(supabaseUserId).catch((delErr: any) => {
            logger.error({
              type: 'auth_register_supabase_rollback_error',
              supabaseUserId,
              error: delErr.message,
            });
          });
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Registration failed. Please try again.',
          });
        }

        if (invitation) {
          await consumeInvitation(invitation.id).catch((err: any) =>
            logger.warn({ type: 'invitation_consume_failed', invitationId: invitation.id, error: err.message })
          );
        }

        // F3.1  -  Create and link Organization if companyName was provided and user has no org yet.
        // Awaited so that user.organizationId is set before the response and first session cache.
        if (input.companyName && !user.organizationId) {
          try {
            const defaultSubscriptionTier = typeof systemConfig.defaultSubscriptionTier === 'string'
              ? systemConfig.defaultSubscriptionTier
              : 'starter';
            const org = await ctx.prisma.organization.create({
              data: {
                name: input.companyName,
                type: resolvedRole,
                subscriptionTier: defaultSubscriptionTier,
                plan: subscriptionTierToPlanOrFree(defaultSubscriptionTier),
                users: { connect: { id: user.id } },
              } as any,
              select: { id: true },
            });
            user.organizationId = org.id;
          } catch (err: any) {
            logger.warn({ type: 'auth_register_org_create_failed', userId: user.id, error: err.message });
          }
        }

        initializeNotificationPreferences(user.id).catch(() => {});

        if (requireEmailVerification && verificationUrl) {
          reactMailer.sendVerificationEmail(user.email, {
            userName: (user as any).fullName || user.email,
            verificationUrl,
            expiresInHours: 24,
          }).catch((err: any) => {
            logger.error({ type: 'auth_register_email_failed', userId: user.id, error: err.message });
          });
        }

        logger.info({ type: 'auth_register_success', userId: user.id, email: maskEmail(user.email), duration: Date.now() - startTime });

        return {
          success: true,
          userId: user.id,
          email: user.email,
          message: requireEmailVerification
            ? 'Registration successful. Please check your email to verify your account.'
            : 'Registration successful. You can now log in.',
        };
      } catch (error: any) {
        if (error instanceof TRPCError && error.code !== 'INTERNAL_SERVER_ERROR') {
          logger.warn({ type: 'auth_register_error', email: maskEmail(input.email), error: error.message, code: error.code, duration: Date.now() - startTime });
        } else {
          logger.error({ type: 'auth_register_error', email: maskEmail(input.email), error: error.message, duration: Date.now() - startTime });
        }
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: getAuthErrorMessage(AUTH_ERROR_CODES.REGISTRATION_FAILED), cause: error });
      }
    }),

  /**
   * Login  -  proxies credentials to Supabase and returns Supabase session tokens.
   * Enforces email verification and account status before granting access.
   * The frontend must store and send the access_token as Bearer on all requests.
   */
  login: publicProcedure
    .input(loginSchema)
    .mutation(async ({ input, ctx }) => {
      const startTime = Date.now();

      try {
        // Rate limiting  -  count by hashed IP in addition to email for layered defence
        const rlResult = await authRateLimiter.login(input.email);
        if (!rlResult.allowed) {
          logger.warn({
            type: 'auth_login_rate_limited',
            email: maskEmail(input.email),
            ipHash: hashIp(ctx.req.ip),
            retryAfter: rlResult.retryAfter,
          });
          const suffix = rlResult.retryAfter ? ` Try again in ${rlResult.retryAfter} seconds.` : '';
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: getAuthErrorMessage(AUTH_ERROR_CODES.RATE_LIMITED_LOGIN) + suffix,
          });
        }

        logger.info({ type: 'auth_login_attempt', email: maskEmail(input.email) });
        const systemConfig = await loadSystemConfig();
        const requireEmailVerification = systemConfig.requireEmailVerification !== false;
        const sessionTtlSeconds = resolveSessionTimeoutSeconds(systemConfig.sessionTimeoutHours);

        const { data: authData, error: authError } = await supabaseClient.auth.signInWithPassword({
          email: input.email,
          password: input.password,
        });

        if (authError || !authData.session || !authData.user) {
          logger.warn({
            type: 'auth_login_failed',
            email: maskEmail(input.email),
            ipHash: hashIp(ctx.req.ip),
          });
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: getAuthErrorMessage(AUTH_ERROR_CODES.INVALID_CREDENTIALS),
          });
        }

        const user = await ctx.prisma.user.findUnique({
          where: { supabaseAuthId: authData.user.id },
          include: { organization: { select: { id: true, name: true, type: true } } },
        });

        // SECURITY: merge deleted-account and not-found into the same generic response
        // to prevent user enumeration via the login path.
        if (!user || (user as any).deletedAt) {
          logger.warn({ type: 'auth_login_account_not_found', ipHash: hashIp(ctx.req.ip) });
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: getAuthErrorMessage(AUTH_ERROR_CODES.INVALID_CREDENTIALS),
          });
        }

        // Safety-net sync: if Supabase has confirmed the email but Prisma hasn't
        // been updated yet (e.g. user closed the callback page before sync completed),
        // reconcile here so login isn't permanently blocked.
        if (!user.emailVerified && authData.user.email_confirmed_at) {
          const syncedStatus = user.role === 'REGULATOR' ? 'pending_approval' : 'active';
          try {
            await ctx.prisma.user.update({
              where: { id: user.id },
              data: {
                emailVerified: true,
                emailVerifiedAt: new Date(authData.user.email_confirmed_at),
                accountStatus: syncedStatus,
              } as any,
            });
            (user as any).emailVerified = true;
            (user as any).accountStatus = syncedStatus;
            logger.info({ type: 'auth_login_prisma_email_synced', userId: user.id });
          } catch (syncErr: any) {
            logger.warn({ type: 'auth_login_prisma_sync_failed', userId: user.id, error: syncErr.message });
          }
        }

        if (!user.emailVerified && !requireEmailVerification) {
          const syncedStatus = user.role === 'REGULATOR' ? 'pending_approval' : 'active';
          try {
            await ctx.prisma.user.update({
              where: { id: user.id },
              data: {
                emailVerified: true,
                emailVerifiedAt: new Date(),
                status: 'ACTIVE',
                accountStatus: syncedStatus,
              } as any,
            });
            (user as any).emailVerified = true;
            (user as any).accountStatus = syncedStatus;
            logger.info({ type: 'auth_login_email_verification_bypassed_by_config', userId: user.id });
          } catch (syncErr: any) {
            logger.warn({ type: 'auth_login_email_bypass_sync_failed', userId: user.id, error: syncErr.message });
          }
        }

        // Block login if email is not yet verified and the current system
        // configuration requires verification.
        if (requireEmailVerification && !user.emailVerified) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: getAuthErrorMessage(AUTH_ERROR_CODES.EMAIL_NOT_VERIFIED),
          });
        }

        // Block login if account is not in active status
        const status = (user as any).accountStatus as string | undefined;
        if (status && status !== 'active') {
          if (status === 'pending_approval') {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: getAuthErrorMessage(AUTH_ERROR_CODES.ACCOUNT_PENDING_APPROVAL),
            });
          }
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: getAuthErrorMessage(AUTH_ERROR_CODES.ACCOUNT_NOT_ACTIVE),
          });
        }

        let dbSessionId: string | undefined;
        try {
          const session = await ctx.prisma.session.create({
            data: {
              userId: user.id,
              token: nanoid(64),
              expiresAt: new Date(Date.now() + sessionTtlSeconds * 1000),
              device: parseDeviceLabel(ctx.req.headers['user-agent']),
              ipAddress: ctx.req.ip || 'Unknown',
              userAgent: ctx.req.headers['user-agent']?.substring(0, 500),
            },
          });
          dbSessionId = session.id;
        } catch (err: any) {
          logger.warn({ type: 'auth_login_session_create_failed', userId: user.id, error: err.message });
        }

        // B6: Include session expiry in the Redis user profile so context.ts
        // can enforce it on every request without an extra DB query.
        // Session.expiresAt is controlled by System Configuration.
        const sessionExpiresAt = Date.now() + sessionTtlSeconds * 1000;

        // Cache user profile in Upstash for fast context lookups (1 hour)
        const userProfile = {
          id: user.id,
          email: user.email,
          role: user.role,
          organizationId: user.organizationId ?? undefined,
          supabaseAuthId: authData.user.id,
          sessionId: dbSessionId,
          sessionExpiresAt,
        };
        await redis.set(`user:session:${authData.user.id}`, JSON.stringify(userProfile), { ex: 3600 });

        // B3: Seed idle-timeout window and absolute session-start on login.
        // Both keys are TTL-only; their string value is the epoch-ms timestamp.
        const loginNow = Date.now();
        await Promise.all([
          redis.set(lastSeenKey(user.id),    String(loginNow), { ex: SESSION_CONFIG.IDLE_TIMEOUT_SECONDS }),
          redis.set(sessionStartKey(user.id), String(loginNow), { ex: sessionTtlSeconds }),
        ]).catch((err: unknown) => {
          logger.warn({ type: 'auth_login_session_keys_failed', userId: user.id, error: err instanceof Error ? err.message : String(err) });
        });

        // B5: Store a session fingerprint (SHA-256 of IP + UA) so context.ts
        // can detect anomalies (UA change, IP change) in monitor mode.
        // Key is scoped to sessionId so each login gets its own fingerprint.
        if (dbSessionId) {
          const rawIp = ctx.req.ip ?? '';
          const rawUa = (ctx.req.headers['user-agent'] ?? '').substring(0, 500);
          const fingerprint = createHash('sha256').update(`${rawIp}:${rawUa}`).digest('hex');
          await redis
            .set(`sheriabot:session_fingerprint:${dbSessionId}`, fingerprint, { ex: sessionTtlSeconds })
            .catch((err: unknown) => {
              logger.warn({ type: 'auth_login_fingerprint_store_failed', userId: user.id, error: err instanceof Error ? err.message : String(err) });
            });
        }

        const loginIp = ctx.req.ip || ctx.req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || null;
        await ctx.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), lastLoginIp: loginIp } });

        // Write audit log entry for login
        await ctx.prisma.auditLog.create({
          data: {
            userId: user.id,
            action: 'USER_LOGIN',
            entityType: 'User',
            entityId: user.id,
            ipAddress: loginIp ?? undefined,
            userAgent: ctx.req.headers['user-agent']?.substring(0, 500),
            metadata: { email: user.email, sessionId: dbSessionId },
          },
        }).catch((err: unknown) => {
          logger.warn({ type: 'auth_login_audit_log_failed', userId: user.id, error: err instanceof Error ? err.message : String(err) });
        });

        logger.info({ type: 'auth_login_success', userId: user.id, loginIp, duration: Date.now() - startTime });

        return {
          accessToken: authData.session.access_token,
          refreshToken: authData.session.refresh_token,
          user: {
            id: user.id,
            email: user.email,
            name: user.fullName,
            role: user.role,
            emailVerified: user.emailVerified,
            organization: user.organization,
            createdAt: user.createdAt,
          },
        };
      } catch (error: any) {
        if (error instanceof TRPCError && error.code !== 'INTERNAL_SERVER_ERROR') {
          logger.warn({ type: 'auth_login_error', email: maskEmail(input.email), error: error.message, code: error.code, duration: Date.now() - startTime });
        } else {
          logger.error({ type: 'auth_login_error', email: maskEmail(input.email), error: error.message, duration: Date.now() - startTime });
        }
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: getAuthErrorMessage(AUTH_ERROR_CODES.SERVER_ERROR), cause: error });
      }
    }),

  /**
   * Logout  -  deletes DB session and invalidates the Upstash Redis user cache.
   */
  logout: protectedProcedure
    .input(z.void())
    .mutation(async ({ ctx }) => {
    const userId = ctx.user!.id;
    const supabaseAuthId = ctx.user!.supabaseAuthId;
    const sessionId = ctx.user!.sessionId;

    logger.info({ type: 'auth_logout', userId });

    // Step 1: security-critical JTI blocklist. This is the only logout step
    // allowed to abort, because the presented token must be unusable after it
    // succeeds.
    try {
      const authorization = ctx.req.headers.authorization;
      const bearerToken = authorization?.startsWith('Bearer ')
        ? authorization.substring(7)
        : null;

      if (!bearerToken) {
        throw new Error('logout_bearer_token_missing');
      }

      await revokeLogoutBearerTokenStrict(bearerToken);
    } catch (error: unknown) {
      logger.error({
        type: 'auth_logout_token_revoke_failed',
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Logout failed. Please try again.',
        cause: error,
      });
    }

    // Step 2: provider session revoke. Non-fatal after JTI blocklist succeeds.
    try {
      await supabaseAdmin.auth.admin.signOut(supabaseAuthId);
    } catch (error: unknown) {
      logger.warn({
        type: 'auth_logout_supabase_signout_failed',
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Step 3: Redis user cache eviction. Non-fatal after JTI blocklist succeeds.
    try {
      await redis.del(`user:session:${supabaseAuthId}`);
    } catch (error: unknown) {
      logger.warn({
        type: 'auth_logout_user_cache_cleanup_failed',
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Step 4: Prisma session deletion. Non-fatal audit/UI consistency cleanup.
    if (sessionId) {
      try {
        await ctx.prisma.session.deleteMany({ where: { id: sessionId, userId } });
      } catch (error: unknown) {
        logger.warn({
          type: 'auth_logout_session_delete_failed',
          userId,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Step 5: B3/B5 key cleanup. Non-fatal after JTI blocklist succeeds.
    try {
      const keysToDelete: string[] = [
        lastSeenKey(userId),
        sessionStartKey(userId),
        ...(sessionId ? [`sheriabot:session_fingerprint:${sessionId}`] : []),
      ];
      await Promise.all(keysToDelete.map((key) => redis.del(key)));
    } catch (error: unknown) {
      logger.warn({
        type: 'auth_logout_session_key_cleanup_failed',
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return { success: true, message: 'Logged out successfully' };
  }),

  /** Get current authenticated user */
  me: protectedProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      try {
        const user = await ctx.prisma.user.findUnique({
          where: { id: ctx.user!.id },
          include: { organization: { select: { id: true, name: true, type: true, registrationNumber: true } } },
        });

      if (!user || (user as any).deletedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      return {
        id: user.id,
        email: user.email,
        name: user.fullName,
        role: user.role,
        phone: user.phone,
        emailVerified: user.emailVerified,
        organization: user.organization,
        preferences: (user as any).preferences,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      };
    } catch (error: any) {
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch user data', cause: error });
    }
  }),

  /**
   * Request password reset  -  F4.2 (complete rewrite).
   *
   * Uses a fully custom Prisma token flow instead of the Supabase-native
   * resetPasswordForEmail(), which sends tokens in a format incompatible with
   * the /reset-password?token= frontend pattern.
   *
   * Flow: generate token -> store in Prisma -> send via React Email template.
   * Always returns success to prevent email enumeration.
   */
  requestPasswordReset: publicProcedure
    .input(resetPasswordRequestSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        // F5.6  -  rate limiting on password reset (was missing entirely)
        const rlResult = await authRateLimiter.resetPassword(input.email);
        enforceRateLimit(rlResult, 'Too many password reset requests. Please try again later.');

        const user = await ctx.prisma.user.findUnique({
          where: { email: input.email },
          select: { id: true, email: true, fullName: true, supabaseAuthId: true },
        });

        // Always return success  -  never reveal whether an account exists
        if (!user) {
          logger.info({ type: 'auth_password_reset_email_not_found', email: input.email });
          return {
            success: true,
            message: 'If an account exists with this email, you will receive a password reset link.',
          };
        }

        const resetToken = generateVerificationToken();
        const resetExpiry = new Date();
        resetExpiry.setMinutes(resetExpiry.getMinutes() + 60); // 60-minute window

        await ctx.prisma.user.update({
          where: { id: user.id },
          data: {
            passwordResetToken: resetToken,
            passwordResetExpiry: resetExpiry,
          } as any,
        });

        const resetUrl = `${appConfig.frontendUrl}/reset-password?token=${resetToken}`;
        reactMailer.sendPasswordResetEmail(user.email, {
          userName: user.fullName || user.email,
          resetUrl,
          expiresInMinutes: 60,
          ipAddress: undefined,
        }).catch((err: any) => {
          logger.error({ type: 'auth_password_reset_email_failed', userId: user.id, error: err.message });
        });

        logger.info({ type: 'auth_password_reset_email_sent', userId: user.id });

        return {
          success: true,
          message: 'If an account exists with this email, you will receive a password reset link.',
        };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Password reset request failed', cause: error });
      }
    }),

  /**
   * Reset password with Prisma DB token.
   * F4.5a  -  error-checks supabaseAdmin.auth.admin.updateUserById().
   * F4.5b  -  revokes all Supabase sessions for the user after reset.
   * F4.6   -  sends a post-reset confirmation email.
   */
  resetPassword: publicProcedure
    .input(resetPasswordSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        await enforcePublicTokenRateLimit(
          ctx.req.ip,
          'reset-password-token',
          5,
          'Too many password reset attempts. Please try again later.',
        );

        const user = await ctx.prisma.user.findFirst({
          where: { passwordResetToken: input.token, passwordResetExpiry: { gt: new Date() } } as any,
        });

        if (!user) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: getAuthErrorMessage(AUTH_ERROR_CODES.INVALID_RESET_TOKEN),
          });
        }

        // Enforce password policy on the new password before updating anything.
        const resetSystemConfig = await loadSystemConfig();
        const pwValidation = validatePassword(input.newPassword, user.email ?? undefined, {
          minLength: Number(resetSystemConfig.passwordMinLength ?? 10),
        });
        if (!pwValidation.isValid) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: pwValidation.errors[0] });
        }

        const hashed = await hashPassword(input.newPassword);

        // Clear the reset token first so it can't be replayed even if later steps fail
        await ctx.prisma.user.update({
          where: { id: user.id },
          data: { password: hashed, passwordResetToken: null, passwordResetExpiry: null } as any,
        });

        if ((user as any).supabaseAuthId) {
          const supabaseAuthId = (user as any).supabaseAuthId as string;

          // F4.5a  -  check the return value; if Supabase update fails log it but
          // don't silently swallow the error as it leaves credentials out of sync
          const { error: supabaseUpdateError } = await supabaseAdmin.auth.admin.updateUserById(
            supabaseAuthId,
            { password: input.newPassword },
          );
          if (supabaseUpdateError) {
            logger.error({
              type: 'auth_password_reset_supabase_update_error',
              userId: user.id,
              error: supabaseUpdateError.message,
            });
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: getAuthErrorMessage(AUTH_ERROR_CODES.RESET_PASSWORD_FAILED),
            });
          }

          // F4.5b  -  revoke all active Supabase sessions so the old password
          // can no longer be used on any logged-in device
          await supabaseAdmin.auth.admin.signOut(supabaseAuthId).catch((signOutErr: any) => {
            logger.warn({
              type: 'auth_password_reset_session_revoke_warn',
              userId: user.id,
              error: signOutErr.message,
            });
          });

          // B4: Mark all tokens issued before this moment as revoked (covers
          // any in-flight JWTs that Supabase signOut may not have invalidated).
          await revokeAllUserTokens(user.id, 'password_change');

          // Invalidate Redis user cache + idle/session-start keys
          await Promise.all([
            redis.del(`user:session:${supabaseAuthId}`),
            redis.del(lastSeenKey(user.id)),
            redis.del(sessionStartKey(user.id)),
          ]).catch(() => {});
        }

        // F4.6  -  notify the user that their password was changed
        reactMailer.sendPasswordChangedEmail(user.email, {
          userName: user.fullName || user.email,
          loginUrl: `${appConfig.frontendUrl}/login`,
        }).catch(() => {});

        logger.info({ type: 'auth_password_reset_success', userId: user.id });

        return { success: true, message: 'Password reset successful. You can now log in with your new password.' };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Password reset failed', cause: error });
      }
    }),

  /** Verify email with DB token (Phase 7 compatible). */
  verifyEmail: publicProcedure
    .input(verifyEmailSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        await enforcePublicTokenRateLimit(
          ctx.req.ip,
          'verify-email-token',
          10,
          'Too many email verification attempts. Please try again later.',
        );

        const user = await ctx.prisma.user.findFirst({
          where: {
            emailVerificationToken: input.token,
            emailVerificationExpiry: { gt: new Date() },
            emailVerified: false,
          } as any,
        });

        if (!user) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid or expired verification token' });
        }

        const newAccountStatus = user.role === 'REGULATOR' ? 'pending_approval' : 'active';

        // Confirm email in Supabase FIRST  -  if this fails the whole mutation fails,
        // keeping Prisma consistent (not marked verified when Supabase isn't).
        if ((user as any).supabaseAuthId) {
          const { error: supabaseError } = await supabaseAdmin.auth.admin.updateUserById(
            (user as any).supabaseAuthId,
            { email_confirm: true },
          );
          if (supabaseError) {
            logger.error({
              type: 'auth_email_verify_supabase_error',
              userId: user.id,
              error: supabaseError.message,
            });
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Failed to confirm email with auth provider. Please try again.',
            });
          }
        }

        await ctx.prisma.user.update({
          where: { id: user.id },
          data: {
            emailVerified: true,
            emailVerifiedAt: new Date(),
            emailVerificationToken: null,
            emailVerificationExpiry: null,
            accountStatus: newAccountStatus,
          } as any,
        });

        if (user.role !== 'REGULATOR') {
          reactMailer.sendWelcomeEmail(user.email, {
            userName: user.fullName || user.email,
            role: user.role,
            dashboardUrl: `${appConfig.frontendUrl}/dashboard`,
          }).catch(() => {});
        }

        logger.info({ type: 'auth_email_verification_success', userId: user.id, accountStatus: newAccountStatus });

        return {
          success: true,
          message: user.role === 'REGULATOR'
            ? 'Email verified successfully. Your account is pending admin approval.'
            : 'Email verified successfully. You can now access all features.',
          requiresApproval: user.role === 'REGULATOR',
        };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Email verification failed', cause: error });
      }
    }),

  /**
   * Resend email verification  -  F3.6 (converted from protectedProcedure to publicProcedure).
   *
   * Previously required an authenticated session, which created a UX deadlock
   * once login enforces emailVerified. Now takes an email address and looks up
   * the user directly, rate-limited at 3/hour by email address.
   */
  resendVerification: publicProcedure
    .input(z.object({ email: z.string().email('Please provide a valid email address') }))
    .mutation(async ({ input, ctx }) => {
      try {
        // Atomic sliding-window rate limit (replaces the old INCR+EXPIRE two-step
        // which had a race: if the process died between the two Redis calls the
        // key never expired, permanently locking the user out).
        const rl = await authRateLimiter.resendVerification(input.email.toLowerCase());
        if (!rl.allowed) {
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: 'Too many verification email requests. Please try again in an hour.',
          });
        }

        const user = await ctx.prisma.user.findUnique({
          where: { email: input.email.toLowerCase() },
          select: { id: true, email: true, fullName: true, emailVerified: true },
        });

        // Always return success  -  don't reveal whether the email is registered
        if (!user) {
          return { success: true, message: 'If an account exists with this email, a verification link has been sent.' };
        }

        if (user.emailVerified) {
          return { success: true, message: 'This email address is already verified.' };
        }

        // Generate a Supabase magic-link for the existing unverified user.
        // This does NOT require the password and produces a real Supabase OTP URL
        // that sets email_confirmed_at when clicked, then redirects to /auth/callback.
        const appCallbackUrl = process.env.APP_CALLBACK_URL || 'https://sheriabot.com/auth/callback';
        const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
          type: 'magiclink',
          email: user.email,
          options: { redirectTo: appCallbackUrl },
        });

        if (linkError || !linkData?.properties?.action_link) {
          logger.error({ type: 'auth_resend_supabase_link_error', userId: user.id, error: linkError?.message });
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to generate verification link. Please try again.' });
        }

        const verificationUrl = linkData.properties.action_link;
        await reactMailer.sendVerificationEmail(user.email, {
          userName: user.fullName || user.email,
          verificationUrl,
          expiresInHours: 24,
        });

        logger.info({ type: 'auth_resend_verification_success', userId: user.id });
        return { success: true, message: 'Verification email sent.' };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to resend verification email', cause: error });
      }
    }),

  /**
   * Confirm email via Supabase callback.
   *
   * Called by the /auth/callback frontend page after the user clicks the
   * Supabase OTP verification link in their email.  Supabase has already set
   * email_confirmed_at by the time this is reached; we use the issued
   * access_token to identify the user and sync Prisma emailVerified.
   *
   * Flow:
   *  1. User clicks Supabase link in email -> Supabase verifies -> redirects to
   *     https://sheriabot.com/auth/callback#access_token=xxx&...
   *  2. Frontend /auth/callback page reads the session via supabase.auth.getSession()
   *  3. Frontend calls this procedure with the access_token
   *  4. We verify the token with Supabase admin, find the Prisma user, and mark
   *     emailVerified = true.
   */
  confirmEmailCallback: publicProcedure
    .input(z.object({ accessToken: z.string().min(1, 'Access token is required') }))
    .mutation(async ({ input, ctx }) => {
      try {
        await enforcePublicTokenRateLimit(
          ctx.req.ip,
          'confirm-email-callback',
          10,
          'Too many email confirmation attempts. Please try again later.',
        );

        // 1. Verify the access token with Supabase and get the authenticated user
        const { data: { user: supabaseUser }, error: supabaseError } =
          await supabaseAdmin.auth.getUser(input.accessToken);

        if (supabaseError || !supabaseUser) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid or expired verification token' });
        }

        // 2. Find the matching Prisma user
        const user = await ctx.prisma.user.findUnique({
          where: { supabaseAuthId: supabaseUser.id },
          select: { id: true, email: true, fullName: true, role: true, emailVerified: true },
        });

        if (!user) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'User account not found' });
        }

        // 3. Idempotent  -  return early if already verified
        if (user.emailVerified) {
          return {
            success: true,
            requiresApproval: user.role === 'REGULATOR',
            alreadyVerified: true,
          };
        }

        const newAccountStatus = user.role === 'REGULATOR' ? 'pending_approval' : 'active';

        // 4. Mark Prisma user as verified
        await ctx.prisma.user.update({
          where: { id: user.id },
          data: {
            emailVerified: true,
            emailVerifiedAt: new Date(),
            emailVerificationToken: null,
            emailVerificationExpiry: null,
            accountStatus: newAccountStatus,
          } as any,
        });

        // 5. Send welcome email for non-regulator users
        if (user.role !== 'REGULATOR') {
          reactMailer.sendWelcomeEmail(user.email, {
            userName: user.fullName || user.email,
            role: user.role,
            dashboardUrl: `${appConfig.frontendUrl}/dashboard`,
          }).catch(() => {});
        }

        logger.info({ type: 'auth_email_callback_verified', userId: user.id, accountStatus: newAccountStatus });

        return {
          success: true,
          requiresApproval: user.role === 'REGULATOR',
          alreadyVerified: false,
        };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Email confirmation failed', cause: error });
      }
    }),

  /**
   * refreshToken  -  deprecated endpoint.
   * Supabase handles token refresh on the frontend automatically.
   * Call supabase.auth.refreshSession() from your Supabase client instead.
   */
  refreshToken: publicProcedure
    .input(refreshTokenSchema)
    .mutation(async ({ ctx }) => {
      await enforcePublicTokenRateLimit(
        ctx.req.ip,
        'refresh-token',
        20,
        'Too many token refresh attempts. Please try again later.',
      );

      throw new TRPCError({
        code: 'METHOD_NOT_SUPPORTED',
        message:
          'Token refresh is now handled by Supabase. ' +
          'Call supabase.auth.refreshSession() from your frontend client.',
      });
    }),
});
