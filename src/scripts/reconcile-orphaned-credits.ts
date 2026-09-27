/**
 * Orphaned Credit Reconciliation Cron Job
 *
 * Scans Redis for un-settled, dangling usage reservations and restores
 * leaked quota back to organizations.
 *
 * Designed for Render Cron Jobs.
 * Command: npm run billing:credits:reconcile
 */

import 'dotenv/config';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { orphanedCreditReconciliationService } from '@/services/orphaned-credit-reconciliation.service';

const LOCK_KEY = 'sheriabot:cron:orphaned-credits-reconciliation:lock';
const LOCK_TTL_SEC = 600; // 10 minutes

async function main(): Promise<void> {
  const lock = await redis.set(LOCK_KEY, new Date().toISOString(), { ex: LOCK_TTL_SEC, nx: true });
  if (lock === null) {
    logger.info({ type: 'orphaned_credits_reconciliation_cron_lock_held' });
    return;
  }

  try {
    logger.info({ type: 'orphaned_credits_reconciliation_cron_start' });
    const result = await orphanedCreditReconciliationService.reconcileOrphanedCredits();
    logger.info({ type: 'orphaned_credits_reconciliation_cron_complete', ...result });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await redis.del(LOCK_KEY).catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    logger.error({
      type: 'orphaned_credits_reconciliation_cron_fatal',
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
