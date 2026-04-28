/**
 * Suppression Service
 *
 * Single source of truth for marketing suppression state. Manages three layers:
 *   1. SuppressionList table  — durable record with reason + audit trail
 *   2. Contact row            — suppressedAt / suppressedReason fields for quick DB joins
 *   3. Redis cache            — O(1) per-email check used by isSuppressed()
 *
 * All functions normalize email via trim().toLowerCase() before every DB or cache
 * operation to prevent casing mismatches bypassing suppression checks.
 *
 * Redis key: sheriabot:marketing:suppression:{emailLower}
 *   presence = suppressed   |   absence = unknown (query DB)
 *
 * API:
 *   suppress(email, reason, addedById?, metadata?) — idempotent upsert
 *   unsuppress(email)                              — idempotent delete (no-op if missing)
 *   isSuppressed(email)                            — single-email check, Redis-first
 *   filterSuppressed(emails)                       — batch check, returns Set<string>
 */

import { SuppressionReason } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_TTL = 3600; // 1 hour — balance between freshness and DB load

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function suppressionCacheKey(emailLower: string): string {
  return `sheriabot:marketing:suppression:${emailLower}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add an email to the suppression list.
 * Idempotent — calling twice for the same email is safe; the original reason is preserved.
 * Also sets suppressedAt / suppressedReason on the matching Contact row (if any).
 */
export async function suppress(
  email: string,
  reason: SuppressionReason,
  addedById?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const normalized = normalizeEmail(email);

  await prisma.suppressionList.upsert({
    where:  { email: normalized },
    create: {
      email:    normalized,
      reason,
      addedById,
      metadata: metadata ?? undefined,
    },
    update: {}, // idempotent — preserve original reason on duplicate
  });

  // Propagate to Contact fields so send-pipeline DB joins see the state
  await prisma.contact.updateMany({
    where: { email: normalized, deletedAt: null },
    data:  { suppressedAt: new Date(), suppressedReason: reason },
  });

  // Set Redis cache (fire-and-forget — non-fatal if Redis is temporarily unavailable)
  void redis
    .set(suppressionCacheKey(normalized), '1', { ex: CACHE_TTL })
    .catch((err: unknown) => {
      logger.warn({
        type:  'suppression_cache_set_failed',
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // Log reason but never the raw email at info level (PII)
  logger.info({ type: 'marketing_suppressed', reason });
  logger.debug({ type: 'marketing_suppressed_detail', email: normalized, reason });
}

/**
 * Remove an email from the suppression list and clear all suppression fields.
 * Idempotent — calling on an email that was never suppressed is a no-op, not an error.
 */
export async function unsuppress(email: string): Promise<void> {
  const normalized = normalizeEmail(email);

  // deleteMany is idempotent — no P2025 if row doesn't exist
  await prisma.suppressionList.deleteMany({
    where: { email: normalized },
  });

  await prisma.contact.updateMany({
    where: { email: normalized, deletedAt: null },
    data:  { suppressedAt: null, suppressedReason: null },
  });

  // Delete Redis key immediately so future isSuppressed calls see the change
  void redis
    .del(suppressionCacheKey(normalized))
    .catch((err: unknown) => {
      logger.warn({
        type:  'suppression_cache_del_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });

  logger.info({ type: 'marketing_unsuppressed' });
  logger.debug({ type: 'marketing_unsuppressed_detail', email: normalized });
}

/**
 * Check whether a single email is suppressed.
 * Redis-first: on a cache hit returns immediately.
 * On a cache miss queries the DB and back-fills the cache if suppressed.
 * Fails open on Redis error (falls through to DB).
 */
export async function isSuppressed(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const cacheKey   = suppressionCacheKey(normalized);

  try {
    const cached = await redis.get<string>(cacheKey);
    if (cached !== null) return true;
  } catch (err: unknown) {
    // Redis unavailable — fall through to DB rather than falsely allowing sends
    logger.warn({
      type:  'suppression_cache_get_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const record = await prisma.suppressionList.findUnique({
    where:  { email: normalized },
    select: { id: true },
  });

  if (record) {
    // Back-fill cache asynchronously
    void redis
      .set(cacheKey, '1', { ex: CACHE_TTL })
      .catch(() => { /* non-fatal */ });
    return true;
  }

  return false;
}

/**
 * Given a list of emails, return the subset that are suppressed as a Set<string>
 * (lowercased, normalized) for O(1) lookup by the send pipeline.
 *
 * Always goes directly to the DB with a single IN query — more efficient than
 * N individual Redis lookups for large recipient lists.
 * Back-fills Redis cache for every suppressed email found.
 */
export async function filterSuppressed(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();

  const normalized = emails.map(normalizeEmail);

  const records = await prisma.suppressionList.findMany({
    where:  { email: { in: normalized } },
    select: { email: true },
  });

  if (records.length === 0) return new Set();

  const suppressedEmails = records.map((r) => r.email);

  // Back-fill Redis cache for the suppressed set (fire-and-forget)
  void Promise.all(
    suppressedEmails.map((e) =>
      redis
        .set(suppressionCacheKey(e), '1', { ex: CACHE_TTL })
        .catch(() => { /* non-fatal */ }),
    ),
  );

  return new Set(suppressedEmails);
}
