import { TRPCError } from '@trpc/server';
import { nanoid } from 'nanoid';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

export type AuthenticatorTransportFuture =
  | 'ble'
  | 'cable'
  | 'hybrid'
  | 'internal'
  | 'nfc'
  | 'smart-card'
  | 'usb';
import { router, publicProcedure, protectedProcedure } from '../trpc/trpc';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { webauthnConfig } from '@/server/config/webauthn';
import {
  PASSKEY_RATE_LIMITS,
  PASSKEY_REDIS_KEYS,
  checkRateLimit,
  checkAuthOptionsRateLimit,
} from '@/server/lib/webauthn-rate-limit';
import { getClientIp } from '@/server/lib/client-ip';
import {
  logSecurityEvent,
  SECURITY_EVENT_TYPES,
} from '@/server/services/audit.service';
import { issueSessionForUser } from '@/server/services/session.service';
import {
  verifyRegistrationSchema,
  generateAuthenticationOptionsSchema,
  verifyAuthenticationSchema,
  renamePasskeySchema,
  deletePasskeySchema,
} from '../schemas/passkey.schema';

export const passkeyRouter = router({
  /**
   * 1. Generate Passkey Registration Options
   */
  generateRegistrationOptions: protectedProcedure
    .mutation(async ({ ctx }) => {
      const userId = ctx.user.id;

      // Rate limit: per userId
      const rl = await checkRateLimit({
        key: PASSKEY_REDIS_KEYS.regOptionsRateLimit(userId),
        max: PASSKEY_RATE_LIMITS.registrationOptions.max,
        windowSec: PASSKEY_RATE_LIMITS.registrationOptions.windowSec,
      });

      if (!rl.allowed) {
        await logSecurityEvent({
          eventType: SECURITY_EVENT_TYPES.PASSKEY_RATE_LIMITED,
          userId,
          organizationId: ctx.user.organizationId,
          ipAddress: getClientIp(ctx.req) ?? undefined,
          userAgent: ctx.req.headers['user-agent'] as string,
          metadata: { action: 'generateRegistrationOptions' },
        });
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'PASSKEY_RATE_LIMITED',
        });
      }

      // Load existing passkeys to exclude them
      const existingPasskeys = await ctx.prisma.passkey.findMany({
        where: { userId },
        select: {
          credentialId: true,
          transports: true,
        },
      });

      const excludeCredentials = existingPasskeys.map((pk) => ({
        id: pk.credentialId,
        transports: pk.transports as AuthenticatorTransportFuture[],
      }));

      const options = await generateRegistrationOptions({
        rpID: webauthnConfig.rpID,
        rpName: webauthnConfig.rpName,
        userID: new TextEncoder().encode(userId),
        userName: ctx.user.email,
        userDisplayName: ctx.user.email,
        attestationType: 'none',
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'preferred',
        },
        excludeCredentials,
      });

      // Cache challenge in Redis with 300s TTL
      await redis.set(
        PASSKEY_REDIS_KEYS.regChallenge(userId),
        options.challenge,
        { ex: 300 },
      );

      await logSecurityEvent({
        eventType: SECURITY_EVENT_TYPES.PASSKEY_REGISTRATION_STARTED,
        userId,
        organizationId: ctx.user.organizationId,
        ipAddress: getClientIp(ctx.req) ?? undefined,
        userAgent: ctx.req.headers['user-agent'] as string,
        metadata: { existingPasskeyCount: existingPasskeys.length },
      });

      return options;
    }),

  /**
   * 2. Verify Passkey Registration Response
   */
  verifyRegistration: protectedProcedure
    .input(verifyRegistrationSchema)
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user.id;

      // Rate limit: per userId
      const rl = await checkRateLimit({
        key: PASSKEY_REDIS_KEYS.regVerifyRateLimit(userId),
        max: PASSKEY_RATE_LIMITS.registrationVerify.max,
        windowSec: PASSKEY_RATE_LIMITS.registrationVerify.windowSec,
      });

      if (!rl.allowed) {
        await logSecurityEvent({
          eventType: SECURITY_EVENT_TYPES.PASSKEY_RATE_LIMITED,
          userId,
          organizationId: ctx.user.organizationId,
          ipAddress: getClientIp(ctx.req) ?? undefined,
          userAgent: ctx.req.headers['user-agent'] as string,
          metadata: { action: 'verifyRegistration' },
        });
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'PASSKEY_RATE_LIMITED',
        });
      }

      // Load challenge from Redis & strictly single-use delete
      const challengeKey = PASSKEY_REDIS_KEYS.regChallenge(userId);
      const challenge = await redis.get<string>(challengeKey);
      await redis.del(challengeKey).catch(() => {});

      if (!challenge) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Passkey registration session expired',
        });
      }

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: input.response as any,
          expectedChallenge: challenge,
          expectedOrigin: webauthnConfig.expectedOrigin,
          expectedRPID: webauthnConfig.rpID,
          requireUserVerification: false,
        });
      } catch (err: any) {
        logger.warn({
          type: 'passkey_registration_verify_error',
          userId,
          error: err.message,
        });
        await logSecurityEvent({
          eventType: SECURITY_EVENT_TYPES.PASSKEY_REGISTRATION_FAILED,
          userId,
          organizationId: ctx.user.organizationId,
          ipAddress: getClientIp(ctx.req) ?? undefined,
          userAgent: ctx.req.headers['user-agent'] as string,
          metadata: { reason: 'verification_exception' },
        });
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Passkey registration failed',
        });
      }

      if (!verification.verified || !verification.registrationInfo) {
        await logSecurityEvent({
          eventType: SECURITY_EVENT_TYPES.PASSKEY_REGISTRATION_FAILED,
          userId,
          organizationId: ctx.user.organizationId,
          ipAddress: getClientIp(ctx.req) ?? undefined,
          userAgent: ctx.req.headers['user-agent'] as string,
          metadata: { reason: 'not_verified' },
        });
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Passkey registration failed',
        });
      }

      const {
        credential,
        credentialDeviceType,
        credentialBackedUp,
        aaguid,
      } = verification.registrationInfo;

      const credentialId = typeof credential.id === 'string'
        ? credential.id
        : Buffer.from(credential.id).toString('base64url');

      const publicKeyBuffer = Buffer.from(credential.publicKey);
      const counter = BigInt(credential.counter ?? 0);
      const backedUp = credentialDeviceType === 'multiDevice' || Boolean(credentialBackedUp);
      const transports = input.response.response.transports ?? [];

      try {
        const passkey = await ctx.prisma.passkey.create({
          data: {
            userId,
            credentialId,
            publicKey: publicKeyBuffer,
            counter,
            deviceName: input.deviceName ?? null,
            transports,
            aaguid: aaguid ?? null,
            backedUp,
          },
          select: {
            id: true,
            deviceName: true,
            createdAt: true,
          },
        });

        await logSecurityEvent({
          eventType: SECURITY_EVENT_TYPES.PASSKEY_REGISTRATION_SUCCESS,
          userId,
          organizationId: ctx.user.organizationId,
          ipAddress: getClientIp(ctx.req) ?? undefined,
          userAgent: ctx.req.headers['user-agent'] as string,
          metadata: {
            passkeyId: passkey.id,
            deviceName: passkey.deviceName,
            aaguid,
            backedUp,
          },
        });

        if (ctx.user.supabaseAuthId) {
          await redis.del(`user:session:${ctx.user.supabaseAuthId}`).catch(() => {});
        }

        return passkey;
      } catch (dbErr: any) {
        if (dbErr.code === 'P2002') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This passkey is already registered',
          });
        }
        logger.error({
          type: 'passkey_create_db_error',
          userId,
          error: dbErr.message,
        });
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to save passkey',
        });
      }
    }),

  /**
   * 3. Generate Passkey Authentication Options
   */
  generateAuthenticationOptions: publicProcedure
    .input(generateAuthenticationOptionsSchema)
    .mutation(async ({ input, ctx }) => {
      const clientIp = getClientIp(ctx.req);
      const sessionIdentifier =
        input.userHandle ||
        ctx.user?.id ||
        (ctx.req as any).cookies?.['session_id'] ||
        (ctx.req as any).cookies?.['sb-access-token'] ||
        undefined;

      const rl = await checkAuthOptionsRateLimit({
        ip: clientIp,
        sessionIdentifier,
      });

      if (!rl.allowed) {
        await logSecurityEvent({
          eventType: SECURITY_EVENT_TYPES.PASSKEY_RATE_LIMITED,
          ipAddress: clientIp ?? 'missing',
          userAgent: ctx.req.headers['user-agent'] as string,
          metadata: {
            action: 'generateAuthenticationOptions',
            reason: !clientIp ? 'missing_client_ip' : 'rate_limit_exceeded',
          },
        });
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'PASSKEY_RATE_LIMITED',
        });
      }

      let allowCredentials: { id: string; type: 'public-key'; transports?: AuthenticatorTransportFuture[] }[] | undefined;

      if (input.userHandle) {
        const userPasskeys = await ctx.prisma.passkey.findMany({
          where: { userId: input.userHandle },
          select: { credentialId: true, transports: true },
        });

        allowCredentials = userPasskeys.map((pk) => ({
          id: pk.credentialId,
          type: 'public-key',
          transports: pk.transports as AuthenticatorTransportFuture[],
        }));
      }

      const challengeId = nanoid(32);
      const options = await generateAuthenticationOptions({
        rpID: webauthnConfig.rpID,
        allowCredentials,
        userVerification: 'preferred',
      });

      // Cache challenge in Redis with 300s TTL
      await redis.set(
        PASSKEY_REDIS_KEYS.authChallenge(challengeId),
        JSON.stringify({
          challenge: options.challenge,
          userHandle: input.userHandle ?? null,
        }),
        { ex: 300 },
      );

      await logSecurityEvent({
        eventType: SECURITY_EVENT_TYPES.PASSKEY_AUTH_STARTED,
        ipAddress: clientIp ?? 'unknown',
        userAgent: ctx.req.headers['user-agent'] as string,
        metadata: {
          challengeId,
          hasUserHandle: Boolean(input.userHandle),
        },
      });

      return {
        options,
        challengeId,
      };
    }),

  /**
   * 4. Verify Passkey Authentication
   */
  verifyAuthentication: publicProcedure
    .input(verifyAuthenticationSchema)
    .mutation(async ({ input, ctx }) => {
      const challengeKey = PASSKEY_REDIS_KEYS.authChallenge(input.challengeId);
      const rlKey = PASSKEY_REDIS_KEYS.authVerifyRateLimit(input.challengeId);

      // Rate limit: per challengeId (5 attempts max)
      const rl = await checkRateLimit({
        key: rlKey,
        max: PASSKEY_RATE_LIMITS.authVerify.max,
        windowSec: PASSKEY_RATE_LIMITS.authVerify.windowSec,
      });

      if (!rl.allowed) {
        await redis.del(challengeKey).catch(() => {});
        await logSecurityEvent({
          eventType: SECURITY_EVENT_TYPES.PASSKEY_RATE_LIMITED,
          ipAddress: getClientIp(ctx.req) ?? undefined,
          userAgent: ctx.req.headers['user-agent'] as string,
          metadata: { action: 'verifyAuthentication', challengeId: input.challengeId },
        });
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'PASSKEY_RATE_LIMITED',
        });
      }

      // Load challenge & delete immediately (single-use)
      const cached = await redis.get<string | Record<string, any>>(challengeKey);
      await redis.del(challengeKey).catch(() => {});

      if (!cached) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Passkey authentication expired',
        });
      }

      const challengeData = typeof cached === 'string' ? JSON.parse(cached) : cached;
      const credentialId = input.response.id;

      const passkey = await ctx.prisma.passkey.findUnique({
        where: { credentialId },
        include: {
          user: {
            include: {
              organization: {
                select: { id: true, name: true, type: true },
              },
            },
          },
        },
      });

      if (!passkey) {
        await logSecurityEvent({
          eventType: SECURITY_EVENT_TYPES.PASSKEY_AUTH_FAILED,
          ipAddress: getClientIp(ctx.req) ?? undefined,
          userAgent: ctx.req.headers['user-agent'] as string,
          metadata: { reason: 'unknown_credential' },
        });
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Passkey verification failed',
        });
      }

      if (challengeData.userHandle && challengeData.userHandle !== passkey.userId) {
        await logSecurityEvent({
          eventType: SECURITY_EVENT_TYPES.PASSKEY_AUTH_FAILED,
          userId: passkey.userId,
          ipAddress: getClientIp(ctx.req) ?? undefined,
          userAgent: ctx.req.headers['user-agent'] as string,
          metadata: { reason: 'user_handle_mismatch' },
        });
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Passkey verification failed',
        });
      }

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: input.response as any,
          expectedChallenge: challengeData.challenge,
          expectedOrigin: webauthnConfig.expectedOrigin,
          expectedRPID: webauthnConfig.rpID,
          credential: {
            id: passkey.credentialId,
            publicKey: new Uint8Array(passkey.publicKey),
            counter: Number(passkey.counter),
            transports: passkey.transports as AuthenticatorTransportFuture[],
          },
          requireUserVerification: false,
        });
      } catch (err: any) {
        logger.warn({
          type: 'passkey_auth_verify_error',
          userId: passkey.userId,
          error: err.message,
        });
        await logSecurityEvent({
          eventType: SECURITY_EVENT_TYPES.PASSKEY_AUTH_FAILED,
          userId: passkey.userId,
          ipAddress: getClientIp(ctx.req) ?? undefined,
          userAgent: ctx.req.headers['user-agent'] as string,
          metadata: { reason: 'signature_invalid' },
        });
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Passkey verification failed',
        });
      }

      if (!verification.verified || !verification.authenticationInfo) {
        await logSecurityEvent({
          eventType: SECURITY_EVENT_TYPES.PASSKEY_AUTH_FAILED,
          userId: passkey.userId,
          ipAddress: getClientIp(ctx.req) ?? undefined,
          userAgent: ctx.req.headers['user-agent'] as string,
          metadata: { reason: 'signature_invalid' },
        });
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Passkey verification failed',
        });
      }

      // Atomic counter update with replay protection
      const newCounter = BigInt(verification.authenticationInfo.newCounter);
      if (newCounter <= passkey.counter) {
        // WebAuthn spec allows counter = 0 for authenticators that don't support it
        if (passkey.counter !== 0n || newCounter !== 0n) {
          await logSecurityEvent({
            eventType: SECURITY_EVENT_TYPES.PASSKEY_COUNTER_REGRESSION,
            userId: passkey.userId,
            ipAddress: getClientIp(ctx.req) ?? undefined,
            userAgent: ctx.req.headers['user-agent'] as string,
            metadata: {
              passkeyId: passkey.id,
              stored: Number(passkey.counter),
              presented: Number(newCounter),
            },
          });
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Passkey verification failed',
          });
        }
      }

      const claim = await ctx.prisma.passkey.updateMany({
        where: { id: passkey.id, counter: passkey.counter },
        data: { counter: newCounter, lastUsedAt: new Date() },
      });

      if (claim.count !== 1) {
        // Concurrent auth — treat as suspicious, force re-auth
        await logSecurityEvent({
          eventType: SECURITY_EVENT_TYPES.PASSKEY_AUTH_FAILED,
          userId: passkey.userId,
          ipAddress: getClientIp(ctx.req) ?? undefined,
          userAgent: ctx.req.headers['user-agent'] as string,
          metadata: { reason: 'counter_race' },
        });
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Passkey authentication conflict, please retry',
        });
      }

      const user = passkey.user;
      if (!user || (user as any).deletedAt || (user as any).accountStatus !== 'active') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Account not active or not found.',
        });
      }

      // Issue session tokens via shared session service
      const sessionPayload = await issueSessionForUser({
        prisma: ctx.prisma,
        redis,
        user: { ...user, hasPasskey: true },
        req: ctx.req,
        reason: 'passkey',
      });

      await logSecurityEvent({
        eventType: SECURITY_EVENT_TYPES.PASSKEY_AUTH_SUCCESS,
        userId: user.id,
        organizationId: user.organizationId,
        ipAddress: getClientIp(ctx.req) ?? undefined,
        userAgent: ctx.req.headers['user-agent'] as string,
        metadata: {
          passkeyId: passkey.id,
          backedUp: passkey.backedUp,
        },
      });

      return sessionPayload;
    }),

  /**
   * 5. List Current User Passkeys
   */
  listUserPasskeys: protectedProcedure
    .query(async ({ ctx }) => {
      const passkeys = await ctx.prisma.passkey.findMany({
        where: { userId: ctx.user.id },
        select: {
          id: true,
          deviceName: true,
          transports: true,
          backedUp: true,
          createdAt: true,
          lastUsedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      return passkeys;
    }),

  /**
   * 6. Rename Passkey
   */
  renamePasskey: protectedProcedure
    .input(renamePasskeySchema)
    .mutation(async ({ input, ctx }) => {
      const passkey = await ctx.prisma.passkey.findUnique({
        where: { id: input.id },
        select: { id: true, userId: true },
      });

      if (!passkey || passkey.userId !== ctx.user.id) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Passkey not found',
        });
      }

      await ctx.prisma.passkey.update({
        where: { id: input.id },
        data: { deviceName: input.deviceName },
      });

      await logSecurityEvent({
        eventType: SECURITY_EVENT_TYPES.PASSKEY_RENAMED,
        userId: ctx.user.id,
        organizationId: ctx.user.organizationId,
        ipAddress: getClientIp(ctx.req) ?? undefined,
        userAgent: ctx.req.headers['user-agent'] as string,
        metadata: {
          passkeyId: input.id,
          deviceName: input.deviceName,
        },
      });

      return { success: true };
    }),

  /**
   * 7. Delete / Revoke Passkey
   */
  deletePasskey: protectedProcedure
    .input(deletePasskeySchema)
    .mutation(async ({ input, ctx }) => {
      const passkey = await ctx.prisma.passkey.findUnique({
        where: { id: input.id },
        select: { id: true, userId: true },
      });

      if (!passkey || passkey.userId !== ctx.user.id) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Passkey not found',
        });
      }

      await ctx.prisma.passkey.delete({
        where: { id: input.id },
      });

      const remainingPasskeyCount = await ctx.prisma.passkey.count({
        where: { userId: ctx.user.id },
      });

      await logSecurityEvent({
        eventType: SECURITY_EVENT_TYPES.PASSKEY_REVOKED,
        userId: ctx.user.id,
        organizationId: ctx.user.organizationId,
        ipAddress: getClientIp(ctx.req) ?? undefined,
        userAgent: ctx.req.headers['user-agent'] as string,
        metadata: {
          passkeyId: input.id,
          remainingPasskeyCount,
        },
      });

      if (ctx.user.supabaseAuthId) {
        await redis.del(`user:session:${ctx.user.supabaseAuthId}`).catch(() => {});
      }

      return { success: true, remainingPasskeyCount };
    }),
});
