/**
 * Suppression Service
 *
 * Single source of truth for marketing suppression state. Manages three layers:
 *   1. SuppressionList table  — durable record with reason + audit trail
 *   2. Contact row            — suppressedAt / suppressedReason fields for quick DB joins
 *   3. Redis cache            — O(1) per-email check used by isSuppressed()
 *   4. Section 34 Restriction — checks User.preferences.section34Restriction for DIRECT_MARKETING
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
 *   isSuppressed(email)                            — single-email check, Redis-first + Section 34 check
 *   filterSuppressed(emails)                       — batch check, returns Set<string> + Section 34 check
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

  await prisma.$transaction(async (tx) => {
    // 1. Durable record in SuppressionList (upsert preserves original addedAt + reason)
    await tx.suppressionList.upsert({
      where:  { email: normalized },
      create: {
        email:     normalized,
        reason,
        addedById: addedById ?? null,
        metadata:  metadata ? (metadata as any) : undefined,
      },
      update: {}, // No-op on duplicate — preserve original suppression record
    });

    // 2. Denormalize onto Contact row for quick join filtering
    await tx.contact.updateMany({
      where: { email: normalized, deletedAt: null },
      data:  {
        suppressedAt:     new Date(),
        suppressedReason: reason,
      },
    });
  });

  // 3. Write-through to Redis cache (non-fatal if Redis is down)
  void redis
    .set(suppressionCacheKey(normalized), '1', { ex: CACHE_TTL })
    .catch((err: unknown) => {
      logger.warn({
        type:  'suppression_cache_write_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });

  logger.info({ type: 'marketing_suppressed', reason });
  logger.debug({ type: 'marketing_suppressed_detail', email: normalized, reason });
}

/**
 * Remove an email from the suppression list.
 * Idempotent — no error if the email was not suppressed.
 * Clears suppressedAt / suppressedReason on matching Contact rows and evicts Redis cache.
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
 * Also enforces active Section 34 DPA restrictions for DIRECT_MARKETING.
 */
export async function isSuppressed(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const cacheKey   = suppressionCacheKey(normalized);

  try {
    const cached = await redis.get<string>(cacheKey);
    if (cached !== null) return true;
  } catch (err: unknown) {
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
    void redis
      .set(cacheKey, '1', { ex: CACHE_TTL })
      .catch(() => { /* non-fatal */ });
    return true;
  }

  // Section 34 Statutory Processing Restriction Check
  const user = await prisma.user.findUnique({
    where: { email: normalized },
    select: { preferences: true },
  });

  if (user?.preferences) {
    const prefs = user.preferences as Record<string, unknown>;
    const restriction = prefs.section34Restriction as any;
    if (
      restriction &&
      restriction.status === 'RESTRICTED' &&
      restriction.restrictedPurposes?.includes('DIRECT_MARKETING')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Given a list of emails, return the subset that are suppressed as a Set<string>
 * (lowercased, normalized) for O(1) lookup by the send pipeline.
 *
 * Checks both SuppressionList table and active Section 34 DIRECT_MARKETING restrictions.
 */
export async function filterSuppressed(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();

  const normalized = emails.map(normalizeEmail);

  const records = await prisma.suppressionList.findMany({
    where:  { email: { in: normalized } },
    select: { email: true },
  });

  const suppressedSet = new Set<string>(records.map((r) => r.email.toLowerCase()));

  // Check Section 34 restrictions for registered users in the batch
  const restrictedUsers = await prisma.user.findMany({
    where: { email: { in: normalized } },
    select: { email: true, preferences: true },
  });

  for (const u of restrictedUsers) {
    if (u.preferences) {
      const prefs = u.preferences as Record<string, unknown>;
      const restriction = prefs.section34Restriction as any;
      if (
        restriction &&
        restriction.status === 'RESTRICTED' &&
        restriction.restrictedPurposes?.includes('DIRECT_MARKETING')
      ) {
        suppressedSet.add(u.email.toLowerCase());
      }
    }
  }

  return suppressedSet;
}
