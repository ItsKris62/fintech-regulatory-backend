/**
 * IntaSend Reconciliation Cron Job
 *
 * Designed for Render Cron Jobs.
 * Command: npm run billing:intasend:reconcile
 */

import 'dotenv/config';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { intaSendReconciliationService } from '@/modules/billing/intasend-reconciliation.service';

const LOCK_KEY = 'sheriabot:cron:intasend-reconciliation:lock';
const LOCK_TTL_SEC = 600;

async function main(): Promise<void> {
  const lock = await redis.set(LOCK_KEY, new Date().toISOString(), { ex: LOCK_TTL_SEC, nx: true });
  if (lock === null) {
    logger.info({ type: 'intasend_reconciliation_cron_lock_held' });
    return;
  }

  try {
    logger.info({ type: 'intasend_reconciliation_cron_start' });
    const result = await intaSendReconciliationService.run();
    logger.info({ type: 'intasend_reconciliation_cron_complete', ...result });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await redis.del(LOCK_KEY).catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    logger.error({
      type: 'intasend_reconciliation_cron_fatal',
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
