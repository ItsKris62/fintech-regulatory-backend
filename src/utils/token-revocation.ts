/**
 * JWT revocation helpers.
 *
 * Two complementary strategies:
 *
 * 1. Per-token JTI blocklist  (`sheriabot:revoked:{jti}`)
 *    Written at logout / password reset for the specific token presented.
 *    TTL = remaining token lifetime so the key self-prunes when the JWT would
 *    have expired anyway.
 *
 * 2. User-level "revoke all"  (`sheriabot:user_tokens_revoked_after:{userId}`)
 *    Written when ALL in-flight tokens for a user must be invalidated (e.g.
 *    after a password change or a forced sign-out).  Any token whose `iat`
 *    (issued-at) is ≤ the stored timestamp is rejected.  TTL = 1 hour (longer
 *    than the Supabase access-token lifetime of 1 hour, so all live tokens
 *    will be caught during at least one validation window).
 */

import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { extractJti, extractExp, extractIat } from '@/utils/jwt';

// ─────────────────────────────────────────────────────────────────────────────
// Key factories
// ─────────────────────────────────────────────────────────────────────────────

/** Redis key for a single revoked JWT ID. */
export const revokedJtiKey = (jti: string) => `sheriabot:revoked:${jti}`;

/**
 * Redis key marking the epoch-second timestamp after which ALL tokens for
 * this user are considered revoked.
 */
export const userRevokedAfterKey = (userId: string) =>
  `sheriabot:user_tokens_revoked_after:${userId}`;

// ─────────────────────────────────────────────────────────────────────────────
// Write helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Blocklist a specific JWT by its JTI claim.
 *
 * @param token  Raw Bearer token string (will be decoded to extract JTI + EXP).
 * @param reason Short tag written as the Redis value for audit queries.
 */
export async function revokeToken(
  token: string,
  reason: 'logout' | 'password_reset' | 'admin_revoke' = 'logout',
): Promise<void> {
  const jti = extractJti(token);
  if (!jti) {
    logger.warn({ type: 'token_revocation_no_jti', reason });
    return; // Supabase tokens always have a JTI; absence means non-Supabase token
  }

  const exp = extractExp(token);
  // TTL = remaining lifetime; floor to 1 second, cap at 2 hours to avoid stale keys
  const ttlSeconds = exp
    ? Math.min(Math.max(exp - Math.floor(Date.now() / 1000), 1), 7200)
    : 3600;

  try {
    await redis.set(revokedJtiKey(jti), reason, { ex: ttlSeconds });
    logger.info({ type: 'token_revoked', jti, reason, ttlSeconds });
  } catch (err: unknown) {
    logger.error({
      type:  'token_revocation_failed',
      jti,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
    // Non-fatal: the Supabase `admin.signOut()` call in the logout handler is
    // the primary revocation mechanism. This blocklist is a defence-in-depth
    // layer and must not cause the logout to fail.
  }
}

/**
 * Revoke ALL currently-live tokens for a user by recording the current
 * epoch-second.  Any token with `iat ≤ now` will be rejected.
 *
 * @param userId Prisma User.id (cuid).
 * @param reason Short audit tag.
 */
export async function revokeAllUserTokens(
  userId: string,
  reason: 'password_change' | 'admin_revoke' | 'security_incident' = 'password_change',
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // TTL of 2 hours covers the full Supabase access-token lifetime (1 h) with margin.
  const ttlSeconds = 7200;

  try {
    await redis.set(userRevokedAfterKey(userId), String(now), { ex: ttlSeconds });
    logger.info({ type: 'all_user_tokens_revoked', userId, reason, revokedAfter: now });
  } catch (err: unknown) {
    logger.error({
      type:   'all_user_tokens_revocation_failed',
      userId,
      reason,
      error:  err instanceof Error ? err.message : String(err),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Check helpers (used in context.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the token has been explicitly revoked (either by JTI
 * or because all tokens for this user were revoked after its `iat`).
 *
 * Fails **open** on Redis errors — if the blocklist is unreachable we still
 * let the Supabase-verified token through rather than knocking everyone out.
 * The primary revocation path (Supabase `admin.signOut`) is unaffected.
 */
export async function isTokenRevoked(
  token: string,
  userId: string,
): Promise<boolean> {
  const jti = extractJti(token);
  const iat = extractIat(token);

  try {
    const checks: Promise<unknown>[] = [];

    // 1. JTI blocklist check
    if (jti) {
      checks.push(redis.exists(revokedJtiKey(jti)));
    }

    // 2. User-level "revoked after" check
    if (iat !== null) {
      checks.push(redis.get<string>(userRevokedAfterKey(userId)));
    }

    const results = await Promise.all(checks);

    // JTI exists in blocklist
    if (jti && (results[0] as number) === 1) {
      logger.warn({ type: 'token_jti_blocklisted', userId, jti });
      return true;
    }

    // Token was issued before the user-level revocation timestamp
    const revokedAfterRaw = (jti ? results[1] : results[0]) as string | null;
    if (revokedAfterRaw && iat !== null) {
      const revokedAfter = Number(revokedAfterRaw);
      if (iat <= revokedAfter) {
        logger.warn({ type: 'token_revoked_by_user_reset', userId, iat, revokedAfter });
        return true;
      }
    }

    return false;
  } catch (err: unknown) {
    logger.warn({
      type:   'token_revocation_check_error',
      userId,
      error:  err instanceof Error ? err.message : String(err),
      action: 'fail_open',
    });
    return false; // fail open — Supabase verified the signature; allow through
  }
}
