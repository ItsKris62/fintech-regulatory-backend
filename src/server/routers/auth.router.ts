import { TRPCError } from '@trpc/server';
import { MemberRole, MemberStatus, PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { router, publicProcedure, protectedProcedure, recordFreshMfaVerification } from '../trpc/trpc';
import {
  registerSchema,
  loginSchema,
  verifyTotpLoginSchema,
  resetPasswordRequestSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  refreshTokenSchema,
} from '../schemas/auth.schema';

import { appConfig } from '@/config/app.config';
import { redis } from '@/lib/redis/client';
import { hashPassword, verifyPassword } from '@/utils/helpers';
import { authRateLimiter, rateLimiter } from '@/lib/redis/rate-limiter';
import { logger } from '@/utils/logger';
import { hashIp, revokedBearerTokenKey } from '@/utils/request-identifiers';
import { getClientIp } from '@/server/lib/client-ip';
import { supabaseAdmin, supabaseClient } from '@/lib/supabase';
import { SESSION_CONFIG, lastSeenKey, sessionStartKey, userSessionKey, sessionFingerprintKey, buildSessionFingerprint } from '@/config/session';
import { logSecurityEvent, SECURITY_EVENT_TYPES } from '@/server/services/audit.service';
import { issueSessionForUser } from '@/server/services/session.service';
import { encryptMfaChallenge, decryptMfaChallenge, MfaChallengeDecryptError } from '@/server/lib/mfa-challenge-crypto';
import { revokedJtiKey, revokeAllUserTokens } from '@/utils/token-revocation';
import { extractExp, extractJti } from '@/utils/jwt';
import { loadSystemConfig } from '@/lib/system-config';
import { durableTaskRunner } from '../services/durable-background-tasks';
import { provisionDefaultOrganization } from '@/services/organization-provisioning.service';

import {
  isFreeEmailDomain,
  FREE_EMAIL_ERROR_MESSAGE,
  isRegulatorDomain,
  findValidInvitation,
  hasPendingInvitation,
  initializeNotificationPreferences,
} from '@/lib/verification/verification.service';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { validatePassword } from '@/shared/validation/password.schema';
import {
  AUTH_ERROR_CODES,
  getAuthErrorMessage,
} from '@/shared/errors/auth-error-messages';
import {
  findValidInvitationByEmailAndToken,
  lockOrganizationSeatAllocation,
  writeSafeAuditLog,
} from '../services/organization-invitation.service';
import {
  buildSeatLimitMessage,
  getSeatUsageForOrganization,
} from '../services/organization-seat.service';

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

        const invitation = input.invitationToken
          ? await findValidInvitation(input.email, input.invitationToken)
          : null;

        if (input.invitationToken && !invitation) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Invalid, expired, revoked, or already-used invitation token.',
          });
        }

        if (!input.invitationToken && await hasPendingInvitation(input.email)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'An invitation token is required to join this organization.',
          });
        }

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
          user = await ctx.prisma.$transaction(async (tx) => {
            let acceptedInvitation: any = null;

            if (input.invitationToken) {
              acceptedInvitation = await findValidInvitationByEmailAndToken(tx as any, input.email, input.invitationToken);
              if (!acceptedInvitation) {
                throw new TRPCError({
                  code: 'BAD_REQUEST',
                  message: 'Invalid, expired, revoked, or already-used invitation token.',
                });
              }

              if (acceptedInvitation.organizationId) {
                await lockOrganizationSeatAllocation(tx as any, acceptedInvitation.organizationId);
                acceptedInvitation = await findValidInvitationByEmailAndToken(tx as any, input.email, input.invitationToken);
                if (!acceptedInvitation) {
                  throw new TRPCError({
                    code: 'BAD_REQUEST',
                    message: 'Invalid, expired, revoked, or already-used invitation token.',
                  });
                }

                const seatUsage = await getSeatUsageForOrganization(tx as any, acceptedInvitation.organizationId);
                const usedSeatsAfterConsumingThisInvite = Math.max(0, seatUsage.usedSeats - 1);
                const canAcceptInvite = seatUsage.seatLimit === -1
                  || usedSeatsAfterConsumingThisInvite < seatUsage.seatLimit;
                if (!canAcceptInvite) {
                  throw new TRPCError({
                    code: 'FORBIDDEN',
                    message: buildSeatLimitMessage(seatUsage),
                  });
                }
              }
            }

            const createdUser = await tx.user.create({
              data: {
                supabaseAuthId: supabaseUserId,
                email: input.email,
                fullName: input.name || input.email,
                role: acceptedInvitation
                  ? (acceptedInvitation.role as 'REGULATOR' | 'STARTUP' | 'ENTERPRISE')
                  : resolvedRole,
                phone: input.phone,
                organizationId: acceptedInvitation?.organizationId ?? undefined,
                emailVerified: !requireEmailVerification,
                emailVerifiedAt: requireEmailVerification ? null : new Date(),
                status: requireEmailVerification ? 'PENDING_VERIFICATION' : 'ACTIVE',
                accountStatus: initialAccountStatus,
              } as any,
              select: { id: true, email: true, fullName: true, role: true, organizationId: true, createdAt: true },
            });

            if (acceptedInvitation) {
              if (acceptedInvitation.organizationId) {
                await tx.organizationMember.upsert({
                  where: {
                    userId_organizationId: {
                      userId: createdUser.id,
                      organizationId: acceptedInvitation.organizationId,
                    },
                  },
                  create: {
                    userId: createdUser.id,
                    organizationId: acceptedInvitation.organizationId,
                    role: (acceptedInvitation.organizationRole ?? MemberRole.MEMBER) as MemberRole,
                    status: MemberStatus.ACTIVE,
                    invitedBy: acceptedInvitation.invitedBy,
                    invitedAt: new Date(),
                  },
                  update: {
                    role: (acceptedInvitation.organizationRole ?? MemberRole.MEMBER) as MemberRole,
                    status: MemberStatus.ACTIVE,
                  },
                });
              }

              await tx.invitation.update({
                where: { id: acceptedInvitation.id },
                data: { used: true, usedAt: new Date() },
              });

              await writeSafeAuditLog(tx as any, {
                userId: createdUser.id,
                action: 'organization_invitation_accepted',
                entityType: 'Invitation',
                entityId: acceptedInvitation.id,
                metadata: {
                  organizationId: acceptedInvitation.organizationId,
                  invitedBy: acceptedInvitation.invitedBy,
                  organizationRole: acceptedInvitation.organizationRole ?? MemberRole.MEMBER,
                },
                ipAddress: getClientIp(ctx.req) ?? null,
                userAgent: ctx.req.headers['user-agent'] ?? null,
              });
            }

            return createdUser;
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
          if (prismaErr instanceof TRPCError) {
            throw prismaErr;
          }
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Registration failed. Please try again.',
          });
        }

        if (invitation?.organizationId) {
          await redis.del(`sheriabot:orgmem:${user.id}:${invitation.organizationId}`).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_1_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
        }

        // Provision organization and owner membership if user has no org yet
        if (!user.organizationId) {
          try {
            const defaultSubscriptionTier = typeof systemConfig.defaultSubscriptionTier === 'string'
              ? systemConfig.defaultSubscriptionTier
              : 'starter';

            const provisionRes = await provisionDefaultOrganization(ctx.prisma as unknown as PrismaClient, {
              user: {
                id: user.id,
                email: user.email,
                fullName: (user as any).fullName,
                role: resolvedRole,
                organizationId: user.organizationId,
              },
              companyName: input.companyName,
              homeJurisdictionCode: input.homeJurisdictionCode,
              defaultSubscriptionTier,
            });

            user.organizationId = provisionRes.organizationId;
          } catch (err: any) {
            logger.warn({ type: 'auth_register_org_provision_failed', userId: user.id, error: err?.message });
          }
        }

        initializeNotificationPreferences(user.id).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_2_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });

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
          requiresEmailVerification: requireEmailVerification,
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
        // Run rate limiting and system configuration concurrently
        const [rlResult, systemConfig] = await Promise.all([
          authRateLimiter.login(input.email),
          loadSystemConfig(),
        ]);

        if (!rlResult.allowed) {
          logger.warn({
            type: 'auth_login_rate_limited',
            email: maskEmail(input.email),
            ipHash: hashIp(getClientIp(ctx.req) ?? undefined),
            retryAfter: rlResult.retryAfter,
          });
          const suffix = rlResult.retryAfter ? ` Try again in ${rlResult.retryAfter} seconds.` : '';
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: getAuthErrorMessage(AUTH_ERROR_CODES.RATE_LIMITED_LOGIN) + suffix,
          });
        }

        logger.info({ type: 'auth_login_attempt', email: maskEmail(input.email) });
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
            ipHash: hashIp(getClientIp(ctx.req) ?? undefined),
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
          logger.warn({ type: 'auth_login_account_not_found', ipHash: hashIp(getClientIp(ctx.req) ?? undefined) });
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
          if (status === 'suspended') {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Your account has been suspended.',
            });
          }
          if (status === 'cancelled') {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'This account has been cancelled.',
            });
          }
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: getAuthErrorMessage(AUTH_ERROR_CODES.ACCOUNT_NOT_ACTIVE),
          });
        }

        if ((user as any).mustChangePassword) {
          const temporaryPasswordExpiresAt = (user as any).temporaryPasswordExpiresAt as Date | null | undefined;
          if (temporaryPasswordExpiresAt && temporaryPasswordExpiresAt <= new Date()) {
            await supabaseAdmin.auth.admin.signOut(authData.user.id).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_3_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
            durableTaskRunner.enqueueAuditLog({
              userId: user.id,
              action: 'PILOT_TEMP_PASSWORD_EXPIRED_LOGIN_ATTEMPT',
              entityType: 'User',
              entityId: user.id,
              ipAddress: getClientIp(ctx.req) || undefined,
              userAgent: ctx.req.headers['user-agent']?.substring(0, 500),
              metadata: { temporaryPasswordExpiresAt: temporaryPasswordExpiresAt.toISOString() },
            });
            logger.warn({
              type: 'pilot_temp_password_expired_login_attempt',
              userId: user.id,
              email: maskEmail(user.email),
            });
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Your temporary password has expired. Please contact the administrator for a new invitation.',
            });
          }
        }

        // If user has 2FA enabled, issue an MFA login challenge token instead of direct session tokens
        if ((user as any).totpEnabled) {
          const tempToken = nanoid(32);
          const encrypted = encryptMfaChallenge({
            userId: user.id,
            accessToken: authData.session.access_token,
            refreshToken: authData.session.refresh_token,
          });

          await redis.set(
            `sheriabot:auth:mfa_challenge:${tempToken}`,
            encrypted,
            { ex: 300 }, // 5 minutes
          );

          logger.info({
            type: 'auth_login_mfa_challenge_issued',
            userId: user.id,
            email: maskEmail(user.email),
          });

          durableTaskRunner.enqueue('log_mfa_challenge_security_event', {
            eventType: SECURITY_EVENT_TYPES.MFA_CHALLENGE_ISSUED,
            userId: user.id,
            organizationId: user.organizationId,
            ipAddress: getClientIp(ctx.req) || undefined,
            userAgent: ctx.req.headers['user-agent'],
          }, (data) => logSecurityEvent(data));

          return {
            mfaRequired: true,
            tempToken,
            accessToken: null,
            refreshToken: null,
            user: null,
          };
        }

        let dbSessionId: string | undefined;
        try {
          const session = await ctx.prisma.session.create({
            data: {
              userId: user.id,
              token: nanoid(64),
              expiresAt: new Date(Date.now() + sessionTtlSeconds * 1000),
              device: parseDeviceLabel(ctx.req.headers['user-agent']),
              ipAddress: getClientIp(ctx.req) || 'Unknown',
              userAgent: ctx.req.headers['user-agent']?.substring(0, 500),
            },
          });
          dbSessionId = session.id;
        } catch (err: any) {
          logger.error({ type: 'auth_login_session_create_failed', userId: user.id, error: err.message });
          await supabaseAdmin.auth.admin.signOut(authData.user.id).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_4_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Unable to create a secure session. Please try again.',
          });
        }

        // B6: Include session expiry in user profile for fast validation
        const sessionExpiresAt = Date.now() + sessionTtlSeconds * 1000;

        // Cache user profile in Upstash for fast context lookups (1 hour)
        const userProfile = {
          id: user.id,
          email: user.email,
          role: user.role,
          organizationId: user.organizationId ?? undefined,
          supabaseAuthId: authData.user.id,
          mustChangePassword: (user as any).mustChangePassword === true,
          totpEnabled: (user as any).totpEnabled ?? false,
          sessionId: dbSessionId,
          sessionExpiresAt,
        };

        const loginNow = Date.now();
        const rawIp = getClientIp(ctx.req) ?? '';
        const rawUa = (ctx.req.headers['user-agent'] ?? '').substring(0, 500);
        const fingerprint = buildSessionFingerprint(rawIp, rawUa);

        // Parallelize all Redis session/state initializations
        // Write to both user.id (Prisma CUID) and authData.user.id (Supabase UUID)
        // to ensure instant hits on tRPC context fast-path lookups (JWT sub).
        const redisWrites: Promise<unknown>[] = [
          redis.set(userSessionKey(user.id), JSON.stringify(userProfile), { ex: 3600 }),
          redis.set(userSessionKey(authData.user.id), JSON.stringify(userProfile), { ex: 3600 }),
          redis.set(lastSeenKey(user.id), String(loginNow), { ex: SESSION_CONFIG.IDLE_TIMEOUT_SECONDS }),
          redis.set(sessionStartKey(user.id), String(loginNow), { ex: sessionTtlSeconds }),
        ];

        if (dbSessionId) {
          redisWrites.push(
            redis.set(sessionFingerprintKey(dbSessionId), fingerprint, { ex: sessionTtlSeconds }),
          );
        }

        await Promise.all(redisWrites).catch((err: unknown) => {
          logger.warn({ type: 'auth_login_session_redis_writes_failed', userId: user.id, error: err instanceof Error ? err.message : String(err) });
        });

        const loginIp = getClientIp(ctx.req);

        // Telemetry offloaded to durable background worker
        durableTaskRunner.enqueueLastLoginUpdate(user.id, loginIp);

        // Synchronous audit logging for strict RPO=0 compliance
        await ctx.prisma.auditLog.create({
          data: {
            userId: user.id,
            action: 'USER_LOGIN',
            entityType: 'User',
            entityId: user.id,
            ipAddress: loginIp ?? undefined,
            userAgent: rawUa,
            metadata: { email: user.email, sessionId: dbSessionId },
          },
        }).catch((err: unknown) => {
          logger.warn({ type: 'auth_login_audit_log_failed', userId: user.id, error: err instanceof Error ? err.message : String(err) });
        });

        logger.info({ type: 'auth_login_success', userId: user.id, loginIp, duration: Date.now() - startTime });

        return {
          mfaRequired: false,
          tempToken: null,
          accessToken: authData.session.access_token,
          refreshToken: authData.session.refresh_token,
          user: {
            id: user.id,
            email: user.email,
            name: user.fullName,
            role: user.role,
            avatar: user.avatar,
            emailVerified: user.emailVerified,
            mustChangePassword: (user as any).mustChangePassword === true,
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
   * Verify TOTP / 2FA login challenge  -  validates OTP or backup code and returns session tokens.
   */
  verifyTotpLogin: publicProcedure
    .input(verifyTotpLoginSchema)
    .mutation(async ({ input, ctx }) => {
      const startTime = Date.now();
      const challengeKey = `sheriabot:auth:mfa_challenge:${input.tempToken}`;
      const attemptKey = `sheriabot:auth:mfa_attempts:${input.tempToken}`;

      try {
        // Rate limiting: cap at 5 attempts per tempToken
        const attempts = await redis.incr(attemptKey);
        if (attempts === 1) {
          await redis.expire(attemptKey, 300);
        }

        if (attempts > 5) {
          await redis.del(challengeKey).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_5_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
          await redis.del(attemptKey).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_6_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
          await logSecurityEvent({
            eventType: SECURITY_EVENT_TYPES.MFA_RATE_LIMITED,
            ipAddress: ctx.req.ip,
            userAgent: ctx.req.headers['user-agent'],
            metadata: { reason: 'tempToken_attempts_exceeded', attempts },
          });
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: 'MFA_ATTEMPTS_EXCEEDED',
          });
        }

        const raw = await redis.get<string>(challengeKey);
        if (!raw) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'MFA session expired or invalid. Please sign in again.',
          });
        }

        const userIdPrefix = typeof raw === 'string' ? raw.split('.')[0] : 'unknown';

        // Global per-user rate limit across multiple tempTokens: 15 attempts in 15 minutes
        if (userIdPrefix && userIdPrefix !== 'unknown') {
          const userAttemptKey = `sheriabot:auth:mfa_user_attempts:${userIdPrefix}`;
          const userAttempts = await redis.incr(userAttemptKey);
          if (userAttempts === 1) {
            await redis.expire(userAttemptKey, 900);
          }

          if (userAttempts > 15) {
            await redis.del(challengeKey).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_7_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
            await logSecurityEvent({
              eventType: SECURITY_EVENT_TYPES.MFA_RATE_LIMITED,
              userId: userIdPrefix,
              ipAddress: getClientIp(ctx.req) || undefined,
              userAgent: ctx.req.headers['user-agent'],
              metadata: { reason: 'user_attempts_exceeded', attempts: userAttempts },
            });
            throw new TRPCError({
              code: 'TOO_MANY_REQUESTS',
              message: 'MFA_ATTEMPTS_EXCEEDED',
            });
          }
        }

        let decrypted: { userId: string; accessToken: string; refreshToken: string };
        try {
          decrypted = decryptMfaChallenge(raw);
        } catch (err) {
          const reason = err instanceof MfaChallengeDecryptError ? err.reason : 'unknown';
          logger.warn({ type: 'mfa_challenge_decrypt_failed', userId: userIdPrefix, ip: getClientIp(ctx.req) || 'unknown', reason });
          await logSecurityEvent({
            eventType: SECURITY_EVENT_TYPES.MFA_CHALLENGE_DECRYPTION_FAILED,
            userId: userIdPrefix !== 'unknown' ? userIdPrefix : undefined,
            ipAddress: getClientIp(ctx.req) || undefined,
            userAgent: ctx.req.headers['user-agent'] as string | undefined,
            metadata: { reason },
          });
          await redis.del(challengeKey).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_8_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'MFA session expired. Please sign in again.' });
        }

        const user = await ctx.prisma.user.findUnique({
          where: { id: decrypted.userId },
          include: {
            organization: { select: { id: true, name: true, type: true } },
            backupCodes: { where: { usedAt: null } },
          },
        });

        if (!user || (user as any).deletedAt || (user as any).accountStatus !== 'active') {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Account not active or not found.',
          });
        }

        let isValidMfa = false;

        if (input.isBackupCode) {
          const cleanCode = input.code.trim().replace(/[-\s]/g, '').toUpperCase();
          if (!/^[A-Z0-9]{8}$/i.test(cleanCode)) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Invalid backup code format. Expected 8 alphanumeric characters.',
            });
          }

          let matchedBackupCodeId: string | null = null;
          for (const bc of user.backupCodes) {
            const matches = await verifyPassword(cleanCode, bc.codeHash);
            if (matches) {
              matchedBackupCodeId = bc.id;
              break;
            }
          }

          if (matchedBackupCodeId) {
            // Atomic single-use claim: only updates if usedAt is still null
            const claimResult = await ctx.prisma.userBackupCode.updateMany({
              where: {
                id: matchedBackupCodeId,
                userId: user.id,
                usedAt: null,
              },
              data: {
                usedAt: new Date(),
              },
            });

            if (claimResult.count === 1) {
              isValidMfa = true;
              logger.info({
                type: 'auth_mfa_backup_code_used',
                userId: user.id,
                backupCodeId: matchedBackupCodeId,
              });
              await logSecurityEvent({
                eventType: SECURITY_EVENT_TYPES.MFA_BACKUP_CODE_USED,
                userId: user.id,
                organizationId: user.organizationId,
                ipAddress: getClientIp(ctx.req) || undefined,
                userAgent: ctx.req.headers['user-agent'],
                metadata: { backupCodeId: matchedBackupCodeId },
              });
            }
          }

          if (!isValidMfa) {
            await logSecurityEvent({
              eventType: SECURITY_EVENT_TYPES.MFA_VERIFY_FAILED,
              userId: user.id,
              organizationId: user.organizationId,
              ipAddress: getClientIp(ctx.req) || undefined,
              userAgent: ctx.req.headers['user-agent'],
              metadata: { method: 'backup_code' },
            });
            throw new TRPCError({
              code: 'UNAUTHORIZED',
              message: 'Invalid backup code. Please check and try again.',
            });
          }
        } else {
          const cleanToken = input.code.trim();
          if (!/^\d{6}$/.test(cleanToken)) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Invalid authentication code. Please enter a 6-digit code.',
            });
          }

          if (!user.totpSecret) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Two-factor authentication is not configured for this account.',
            });
          }
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const otplib = require('otplib');
          const verified = await otplib.verify({
            secret: user.totpSecret,
            token: cleanToken,
          });
          if (verified?.valid !== true) {
            await logSecurityEvent({
              eventType: SECURITY_EVENT_TYPES.MFA_VERIFY_FAILED,
              userId: user.id,
              organizationId: user.organizationId,
              ipAddress: getClientIp(ctx.req) || undefined,
              userAgent: ctx.req.headers['user-agent'],
              metadata: { method: 'totp' },
            });
            throw new TRPCError({
              code: 'UNAUTHORIZED',
              message: 'Invalid authentication code. Please check your authenticator app and try again.',
            });
          }
          isValidMfa = true;
        }

        // Terminal success: Delete challenge key and rate limit attempt counters
        const userAttemptKey = `sheriabot:auth:mfa_user_attempts:${decrypted.userId}`;
        await Promise.all([
          redis.del(challengeKey),
          redis.del(attemptKey),
          redis.del(userAttemptKey),
        ]).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_9_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });

        await logSecurityEvent({
          eventType: SECURITY_EVENT_TYPES.MFA_VERIFY_SUCCESS,
          userId: user.id,
          organizationId: user.organizationId,
          ipAddress: getClientIp(ctx.req) || undefined,
          userAgent: ctx.req.headers['user-agent'],
          metadata: { method: input.isBackupCode ? 'backup_code' : 'totp' },
        });

        const systemConfig = await loadSystemConfig();
        const sessionTtlSeconds = resolveSessionTimeoutSeconds(systemConfig.sessionTimeoutHours);

        await recordFreshMfaVerification(user.id);
        const sessionResult = await issueSessionForUser({
          prisma: ctx.prisma,
          redis,
          user,
          req: ctx.req,
          reason: input.isBackupCode ? 'backup_code' : 'password_totp',
          supabaseTokens: {
            accessToken: decrypted.accessToken,
            refreshToken: decrypted.refreshToken,
            supabaseAuthId: user.supabaseAuthId ?? undefined,
          },
          sessionTtlSeconds,
        });

        logger.info({
          type: 'auth_mfa_login_success',
          userId: user.id,
          loginIp: getClientIp(ctx.req) || 'unknown',
          duration: Date.now() - startTime,
        });

        return sessionResult;
      } catch (error: any) {
        if (error instanceof TRPCError && error.code !== 'INTERNAL_SERVER_ERROR') {
          logger.warn({ type: 'auth_verify_mfa_error', error: error.message, code: error.code, duration: Date.now() - startTime });
        } else {
          logger.error({ type: 'auth_verify_mfa_error', error: error.message, duration: Date.now() - startTime });
        }
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to complete two-factor authentication', cause: error });
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
      await redis.del(userSessionKey(userId));
      if (supabaseAuthId) {
        await redis.del(`user:session:${supabaseAuthId}`).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_10_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
      }
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
        userSessionKey(userId),
        lastSeenKey(userId),
        sessionStartKey(userId),
        `sheriabot:admin:mfa_verified:${userId}`,
        ...(sessionId ? [sessionFingerprintKey(sessionId)] : []),
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
          include: {
            organization: {
              select: {
                id: true,
                name: true,
                type: true,
                registrationNumber: true,
                requireMfa: true,
              } as any,
            },
          },
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
        totpEnabled: (user as any).totpEnabled ?? false,
        organization: user.organization,
        preferences: (user as any).preferences,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        mustChangePassword: (user as any).mustChangePassword === true,
      };
    } catch (error: any) {
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch user data', cause: error });
    }
  }),

  changeTemporaryPassword: protectedProcedure
    .input(z.object({
      currentPassword: z.string().min(1, 'Current temporary password is required'),
      newPassword: z.string().min(1, 'New password is required'),
      confirmPassword: z.string().min(1, 'Please confirm your new password'),
    }).refine((data) => data.newPassword === data.confirmPassword, {
      message: 'New password and confirmation do not match',
      path: ['confirmPassword'],
    }))
    .mutation(async ({ input, ctx }) => {
      const rateCheck = await rateLimiter.check(ctx.user!.id, 'change-temporary-password', 5, 900, { failClosed: true });
      enforceRateLimit(rateCheck, 'Too many password change attempts. Please try again later.');

      const user = await ctx.prisma.user.findUnique({
        where: { id: ctx.user!.id },
        select: {
          id: true,
          email: true,
          fullName: true,
          password: true,
          supabaseAuthId: true,
          mustChangePassword: true,
          temporaryPasswordExpiresAt: true,
        },
      });

      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      if (!(user as any).mustChangePassword) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Temporary password change is not required for this account.' });
      }

      const expiresAt = (user as any).temporaryPasswordExpiresAt as Date | null;
      if (expiresAt && expiresAt <= new Date()) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Your temporary password has expired. Please contact the administrator for a new invitation.',
        });
      }

      if (!user.password || !(await verifyPassword(input.currentPassword, user.password))) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Current temporary password is incorrect.' });
      }

      if (input.currentPassword === input.newPassword) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'New password must be different from the temporary password.' });
      }

      const systemConfig = await loadSystemConfig();
      const pwValidation = validatePassword(input.newPassword, user.email, {
        minLength: Number(systemConfig.passwordMinLength ?? 10),
      });
      if (!pwValidation.isValid) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: pwValidation.errors[0] });
      }

      const hashed = await hashPassword(input.newPassword);
      await ctx.prisma.user.update({
        where: { id: user.id },
        data: {
          password: hashed,
          mustChangePassword: false,
          temporaryPasswordUsedAt: new Date(),
          temporaryPasswordDeliveryStatus: 'USED',
          updatedAt: new Date(),
        } as any,
      });

      if ((user as any).supabaseAuthId) {
        const { error: supabaseUpdateError } = await supabaseAdmin.auth.admin.updateUserById(
          (user as any).supabaseAuthId,
          { password: input.newPassword },
        );
        if (supabaseUpdateError) {
          logger.error({
            type: 'pilot_temp_password_supabase_update_failed',
            userId: user.id,
            error: supabaseUpdateError.message,
          });
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update password. Please try again.' });
        }

        await redis.del(userSessionKey(user.id)).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_11_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
        if ((user as any).supabaseAuthId) {
          await redis.del(`user:session:${(user as any).supabaseAuthId}`).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_12_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
        }
      }
      await redis.del(lastSeenKey(user.id)).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_13_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
      await redis.del(sessionStartKey(user.id)).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_14_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
      await redis.del(`sheriabot:admin:mfa_verified:${user.id}`).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_15_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });

      await ctx.prisma.auditLog.create({
        data: {
          userId: user.id,
          action: 'PILOT_TEMP_PASSWORD_CHANGE_COMPLETED',
          entityType: 'User',
          entityId: user.id,
          ipAddress: ctx.req.ip || undefined,
          userAgent: ctx.req.headers['user-agent']?.substring(0, 500),
          metadata: { completedAt: new Date().toISOString() },
        },
      }).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_16_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });

      reactMailer.sendPasswordChangedEmail(user.email, {
        userName: user.fullName || user.email,
        loginUrl: `${appConfig.frontendUrl}/login`,
      }).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_17_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });

      logger.info({ type: 'pilot_temp_password_change_completed', userId: user.id });
      return { success: true, message: 'Password changed successfully.' };
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
            redis.del(userSessionKey(user.id)),
            redis.del(lastSeenKey(user.id)),
            redis.del(sessionStartKey(user.id)),
            redis.del(`sheriabot:admin:mfa_verified:${user.id}`),
            ...(supabaseAuthId ? [redis.del(`user:session:${supabaseAuthId}`)] : []),
          ]).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_18_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
        }

        // F4.6  -  notify the user that their password was changed
        reactMailer.sendPasswordChangedEmail(user.email, {
          userName: user.fullName || user.email,
          loginUrl: `${appConfig.frontendUrl}/login`,
        }).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_19_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });

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
          }).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_20_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
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
          select: {
            id: true,
            email: true,
            fullName: true,
            role: true,
            emailVerified: true,
            organizationId: true,
            mustChangePassword: true,
            totpEnabled: true,
            accountStatus: true,
          },
        });

        if (!user) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'User account not found' });
        }

        const newAccountStatus = user.role === 'REGULATOR' ? 'pending_approval' : 'active';
        const wasAlreadyVerified = !!user.emailVerified;

        // 3. Mark Prisma user as verified if not already
        if (!wasAlreadyVerified) {
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

          // Send welcome email for non-regulator users
          if (user.role !== 'REGULATOR') {
            reactMailer.sendWelcomeEmail(user.email, {
              userName: user.fullName || user.email,
              role: user.role,
              dashboardUrl: `${appConfig.frontendUrl}/dashboard`,
            }).catch((err: unknown) => {
      logger.warn({
        type: 'auth_router_bg_op_21_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
          }

          logger.info({ type: 'auth_email_callback_verified', userId: user.id, accountStatus: newAccountStatus });
        }

        // 4. Issue session and hydrate Redis cache for active accounts
        let sessionData: { id: string; expiresAt: Date } | null = null;
        if (newAccountStatus === 'active' || (wasAlreadyVerified && user.accountStatus === 'active')) {
          const sessionTtlSeconds = SESSION_CONFIG.ABSOLUTE_TIMEOUT_SECONDS;
          const rawUa = typeof ctx.req.headers['user-agent'] === 'string' ? ctx.req.headers['user-agent'] : '';
          const loginIp = getClientIp(ctx.req) || 'Unknown';

          try {
            const dbSession = await ctx.prisma.session.create({
              data: {
                userId: user.id,
                token: nanoid(64),
                expiresAt: new Date(Date.now() + sessionTtlSeconds * 1000),
                device: parseDeviceLabel(rawUa),
                ipAddress: loginIp,
                userAgent: rawUa ? rawUa.substring(0, 500) : null,
              },
              select: { id: true, expiresAt: true },
            });
            sessionData = dbSession;

            const sessionExpiresAt = Date.now() + sessionTtlSeconds * 1000;
            const userProfile = {
              id: user.id,
              email: user.email,
              role: user.role,
              organizationId: user.organizationId ?? undefined,
              supabaseAuthId: supabaseUser.id,
              mustChangePassword: (user as any).mustChangePassword === true,
              totpEnabled: (user as any).totpEnabled ?? false,
              sessionId: dbSession.id,
              sessionExpiresAt,
            };

            const loginNow = Date.now();
            const fingerprint = buildSessionFingerprint(loginIp, rawUa);

            await Promise.all([
              redis.set(userSessionKey(user.id), JSON.stringify(userProfile), { ex: 3600 }),
              redis.set(userSessionKey(supabaseUser.id), JSON.stringify(userProfile), { ex: 3600 }),
              redis.set(lastSeenKey(user.id), String(loginNow), { ex: SESSION_CONFIG.IDLE_TIMEOUT_SECONDS }),
              redis.set(sessionStartKey(user.id), String(loginNow), { ex: sessionTtlSeconds }),
              redis.set(sessionFingerprintKey(dbSession.id), fingerprint, { ex: sessionTtlSeconds }),
            ]).catch((err: unknown) => {
              logger.warn({ type: 'auth_email_callback_redis_writes_failed', userId: user.id, error: err instanceof Error ? err.message : String(err) });
            });
          } catch (sessionErr: any) {
            logger.warn({ type: 'auth_email_callback_session_creation_failed', userId: user.id, error: sessionErr?.message });
          }
        }

        return {
          success: true,
          requiresApproval: user.role === 'REGULATOR',
          alreadyVerified: wasAlreadyVerified,
          session: sessionData ? { id: sessionData.id, expiresAt: sessionData.expiresAt.toISOString() } : null,
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
        getClientIp(ctx.req) ?? '',
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
