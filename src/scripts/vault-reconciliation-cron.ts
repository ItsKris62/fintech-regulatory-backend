/**
 * Vault Reconciliation Cron Job
 *
 * Nightly reconciliation of R2 vault/ objects against VaultDocument rows.
 * Detects and cleans up R2 orphans; surfaces DB orphans for human review.
 *
 * Render Cron Job config:
 *   Command:  pnpm vault:cron
 *   Schedule: 0 0 * * *  (00:00 UTC = 03:00 Africa/Nairobi)
 *   Region:   Same region as the API service
 *
 * First-run validation:
 *   VAULT_RECONCILIATION_DRY_RUN defaults to true. The cron logs what it
 *   would delete without acting. Flip to false after 2 nights of clean logs.
 */

import 'dotenv/config';
import { runVaultReconciliation } from '@/modules/vault/reconciliation.service';
import { logger } from '@/utils/logger';

async function main(): Promise<void> {
  logger.info({ type: 'vault.reconciliation.cron.start' });

  try {
    const stats = await runVaultReconciliation();
    logger.info({
      type: 'vault.reconciliation.cron.exit',
      success: true,
      ...stats,
    });
    process.exit(0);
  } catch (err: unknown) {
    logger.error({
      type: 'vault.reconciliation.cron.exit',
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

void main();
