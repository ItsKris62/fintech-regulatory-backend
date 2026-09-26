import { TRPCError } from '@trpc/server';

import { nanoid } from 'nanoid';
import { logger } from '@/utils/logger';
import { SESSION_CONFIG, lastSeenKey, sessionStartKey, userSessionKey, sessionFingerprintKey, buildSessionFingerprint } from '@/config/session';
import { supabaseAdmin, supabaseClient } from '@/lib/supabase';

export function parseDeviceLabel(userAgent: string | undefined): string {
  if (!userAgent) return 'Unknown Device';
  if (/iPhone|iPad/.test(userAgent)) return 'iOS Device';
  if (/Android/.test(userAgent)) return 'Android Device';
  if (/Windows/.test(userAgent)) return 'Windows Browser';
  if (/Mac OS/.test(userAgent)) return 'macOS Browser';
  if (/Linux/.test(userAgent)) return 'Linux Browser';
  return 'Unknown Device';
}

export function resolveSessionTimeoutSeconds(sessionTimeoutHours: unknown): number {
  const hours = Number(sessionTimeoutHours);
  const fallbackHours = SESSION_CONFIG.ABSOLUTE_TIMEOUT_SECONDS / 3600;
  const resolvedHours = Number.isFinite(hours) && hours > 0 ? hours : fallbackHours;
  return Math.round(Math.min(Math.max(resolvedHours, 1), 720) * 3600);
}

export interface IssueSessionParams {
  prisma: any;
  redis: any;
  user: any;
  req: {
    ip?: string;
    headers: Record<string, string | string[] | undefined>;
  };
  res?: any;
  reason: 'password' | 'password_totp' | 'backup_code' | 'passkey';
  supabaseTokens?: {
    accessToken: string;
    refreshToken: string | null;
    supabaseAuthId?: string;
  };
  sessionTtlSeconds?: number;
}

export interface SessionResponsePayload {
  mfaRequired: false;
  tempToken: null;
  accessToken: string;
  refreshToken: string | null;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    avatar?: string | null;
    emailVerified: boolean;
    mustChangePassword: boolean;
    organization: any;
    createdAt: Date;
  };
}

/**
 * Shared session issuance service for password, TOTP, backup code, and Passkey authentications.
 * Creates DB session, syncs Redis user cache and session fingerprints, updates user login timestamps,
 * and records audit logs consistently.
 */
export async function issueSessionForUser(params: IssueSessionParams): Promise<SessionResponsePayload> {
  const { prisma, redis, user, req, reason } = params;

  let accessToken = params.supabaseTokens?.accessToken;
  let refreshToken = params.supabaseTokens?.refreshToken ?? null;
  let supabaseAuthId = params.supabaseTokens?.supabaseAuthId || user.supabaseAuthId;

  // If no Supabase tokens were provided (e.g. passwordless Passkey login), mint them via magiclink exchange
  if (!accessToken) {
    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: user.email,
    });

    if (linkError || !linkData?.properties?.hashed_token) {
      logger.error({ type: 'auth_passkey_mint_link_error', userId: user.id, error: linkError?.message });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to mint authentication session. Please try again.',
      });
    }

    const { data: otpData, error: otpError } = await supabaseClient.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: 'magiclink',
    });

    if (otpError || !otpData?.session?.access_token) {
      logger.error({ type: 'auth_passkey_verify_otp_error', userId: user.id, error: otpError?.message });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to establish authentication session. Please try again.',
      });
    }

    accessToken = otpData.session.access_token;
    refreshToken = otpData.session.refresh_token ?? null;
    supabaseAuthId = otpData.user?.id || supabaseAuthId;
  }

  const sessionTtlSeconds = params.sessionTtlSeconds || SESSION_CONFIG.ABSOLUTE_TIMEOUT_SECONDS;
  const rawUa = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';
  const forwardedFor = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0]?.trim() : undefined;
  const loginIp = req.ip || forwardedFor || null;

  let dbSessionId: string | undefined;
  try {
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        token: nanoid(64),
        expiresAt: new Date(Date.now() + sessionTtlSeconds * 1000),
        device: parseDeviceLabel(rawUa),
        ipAddress: loginIp || 'Unknown',
        userAgent: rawUa ? rawUa.substring(0, 500) : null,
      },
    });
    dbSessionId = session.id;
  } catch (err: any) {
    logger.error({ type: 'auth_issue_session_create_failed', userId: user.id, error: err.message, reason });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Unable to create a secure session. Please try again.',
    });
  }

  const sessionExpiresAt = Date.now() + sessionTtlSeconds * 1000;
  const userProfile = {
    id: user.id,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId ?? undefined,
    supabaseAuthId: supabaseAuthId || undefined,
    mustChangePassword: (user as any).mustChangePassword === true,
    totpEnabled: (user as any).totpEnabled ?? false,
    hasPasskey: (user as any).hasPasskey ?? false,
    sessionId: dbSessionId,
    sessionExpiresAt,
  };

  await redis.set(userSessionKey(user.id), JSON.stringify(userProfile), { ex: 3600 });
  if (supabaseAuthId) {
    await redis.set(userSessionKey(supabaseAuthId), JSON.stringify(userProfile), { ex: 3600 }).catch((err: unknown) => {
      logger.warn({
        type: 'session_service_bg_op_1_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  const loginNow = Date.now();
  await Promise.all([
    redis.set(lastSeenKey(user.id), String(loginNow), { ex: SESSION_CONFIG.IDLE_TIMEOUT_SECONDS }),
    redis.set(sessionStartKey(user.id), String(loginNow), { ex: sessionTtlSeconds }),
  ]).catch((err: unknown) => {
      logger.warn({
        type: 'session_service_bg_op_2_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });

  if (dbSessionId) {
    const fingerprint = buildSessionFingerprint(loginIp, rawUa);
    await redis
      .set(sessionFingerprintKey(dbSessionId), fingerprint, { ex: sessionTtlSeconds })
      .catch((err: unknown) => {
      logger.warn({
        type: 'session_service_bg_op_3_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), lastLoginIp: loginIp },
  }).catch((err: unknown) => {
      logger.warn({
        type: 'session_service_bg_op_4_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });

  const actionMap: Record<string, string> = {
    password_totp: 'USER_LOGIN_MFA_TOTP',
    backup_code: 'USER_LOGIN_MFA_BACKUP_CODE',
    passkey: 'USER_LOGIN_PASSKEY',
    password: 'USER_LOGIN_PASSWORD',
  };

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: actionMap[reason] || 'USER_LOGIN',
      entityType: 'User',
      entityId: user.id,
      ipAddress: loginIp ?? undefined,
      userAgent: rawUa ? rawUa.substring(0, 500) : undefined,
      metadata: { email: user.email, sessionId: dbSessionId, reason },
    },
  }).catch((err: unknown) => {
      logger.warn({
        type: 'session_service_bg_op_5_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });

  return {
    mfaRequired: false,
    tempToken: null,
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.fullName || user.email,
      role: user.role,
      avatar: user.avatar,
      emailVerified: user.emailVerified,
      mustChangePassword: (user as any).mustChangePassword === true,
      organization: user.organization,
      createdAt: user.createdAt,
    },
  };
}
