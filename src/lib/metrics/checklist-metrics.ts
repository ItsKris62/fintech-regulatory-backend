/**
 * Checklist Generation Metrics
 *
 * Tracks success/failure rates for the three-tier generation pipeline
 * using Upstash Redis hash counters.
 *
 * Keys:
 *   sheriabot:checklist:metrics:alltime        -  persistent global hash (no TTL)
 *   sheriabot:checklist:metrics:daily:{date}   -  daily hash (TTL 35 days)
 *
 * Hash fields:
 *   attempts             -  total runGeneration() calls (fresh + retries)
 *   success:full         -  Tier 1 successes
 *   success:simplified   -  Tier 2 successes
 *   success:minimal      -  Tier 3 successes
 *   success:partial      -  partial-recovery successes (any tier)
 *   failure              -  all-tiers-failed outcomes
 *   retry_attempts       -  retryChecklist() initiations
 *
 * All counter calls are fire-and-forget with a silent .catch()  -  metrics
 * must NEVER block or throw in the generation hot path.
 */

import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';

// --- Key helpers -------------------------------------------------------------

const ALLTIME_KEY = 'sheriabot:checklist:metrics:alltime';
const DAILY_TTL   = 35 * 24 * 60 * 60; // 35 days in seconds

function dailyKey(): string {
  return `sheriabot:checklist:metrics:daily:${new Date().toISOString().slice(0, 10)}`;
}

type SuccessTier = 'full' | 'simplified' | 'minimal' | 'partial';

// --- Internal helper ----------------------------------------------------------

/**
 * Increment a single field on both the all-time and today's daily hash.
 * Fire-and-forget  -  never awaited in the hot path.
 */
function inc(field: string): void {
  const key = dailyKey();
  Promise.all([
    redis.hincrby(ALLTIME_KEY, field, 1),
    redis.hincrby(key, field, 1).then(() =>
      // Refresh TTL on every write so the key lives 35 days from last write
      redis.expire(key, DAILY_TTL)
    ),
  ]).catch((err: unknown) => {
    logger.warn({
      type:  'checklist_metrics_write_error',
      field,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// --- Public API ---------------------------------------------------------------

/**
 * Call at the start of runGeneration()  -  counts every attempt including retries.
 */
export function recordAttempt(): void {
  inc('attempts');
}

/**
 * Call when a tier succeeds inside runGenerationWithFallback().
 * generationTier is 'full' | 'simplified' | 'minimal' | 'partial'.
 */
export function recordSuccess(tier: SuccessTier): void {
  inc(`success:${tier}`);
}

/**
 * Call in the all-tiers-failed block of runGenerationWithFallback().
 */
export function recordFailure(): void {
  inc('failure');
}

/**
 * Call when retryChecklist() successfully initiates a new generation.
 */
export function recordRetryAttempt(): void {
  inc('retry_attempts');
}

// --- Stats reader -------------------------------------------------------------

export interface ChecklistMetricsStats {
  /** Window: 'alltime' or an ISO date string for the daily snapshot. */
  window: string;
  attempts:       number;
  successFull:    number;
  successSimplified: number;
  successMinimal: number;
  successPartial: number;
  totalSuccess:   number;
  failure:        number;
  retryAttempts:  number;
  /** null when attempts === 0. */
  successRatePct: number | null;
  /** Breakdown of successes by tier (only non-zero tiers included). */
  tierBreakdown: Record<string, string>;
}

function parseCount(raw: string | null): number {
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Read the all-time or daily stats from Redis.
 * @param window 'alltime' (default) | 'today' | ISO date string 'YYYY-MM-DD'
 */
export async function getStats(window: 'alltime' | 'today' | string = 'alltime'): Promise<ChecklistMetricsStats> {
  const key =
    window === 'alltime' ? ALLTIME_KEY :
    window === 'today'   ? dailyKey()  :
    `sheriabot:checklist:metrics:daily:${window}`;

  const raw = await redis.hgetall(key) as Record<string, string> | null;
  const h   = raw ?? {};

  const attempts           = parseCount(h['attempts']);
  const successFull        = parseCount(h['success:full']);
  const successSimplified  = parseCount(h['success:simplified']);
  const successMinimal     = parseCount(h['success:minimal']);
  const successPartial     = parseCount(h['success:partial']);
  const totalSuccess       = successFull + successSimplified + successMinimal + successPartial;
  const failure            = parseCount(h['failure']);
  const retryAttempts      = parseCount(h['retry_attempts']);

  const successRatePct = attempts === 0
    ? null
    : Math.round((totalSuccess / attempts) * 1000) / 10; // one decimal place

  const tierBreakdown: Record<string, string> = {};
  if (successFull)       tierBreakdown['full']       = `${successFull} (${pct(successFull, totalSuccess)}%)`;
  if (successSimplified) tierBreakdown['simplified']  = `${successSimplified} (${pct(successSimplified, totalSuccess)}%)`;
  if (successMinimal)    tierBreakdown['minimal']     = `${successMinimal} (${pct(successMinimal, totalSuccess)}%)`;
  if (successPartial)    tierBreakdown['partial']     = `${successPartial} (${pct(successPartial, totalSuccess)}%)`;

  return {
    window: window === 'alltime' ? 'alltime' : (window === 'today' ? new Date().toISOString().slice(0, 10) : window),
    attempts,
    successFull,
    successSimplified,
    successMinimal,
    successPartial,
    totalSuccess,
    failure,
    retryAttempts,
    successRatePct,
    tierBreakdown,
  };
}

function pct(n: number, total: number): string {
  if (total === 0) return '0';
  return (Math.round((n / total) * 1000) / 10).toFixed(1);
}
