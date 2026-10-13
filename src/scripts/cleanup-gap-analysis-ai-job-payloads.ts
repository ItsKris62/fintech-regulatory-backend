/**
 * Controlled cleanup for historical Gap Analysis AiJob payloads.
 *
 * Dry-run (default): pnpm gap-analysis:cleanup-legacy-payloads
 * Execute non-production: pnpm gap-analysis:cleanup-legacy-payloads -- --execute
 * Execute production: add both --execute and --confirm-production after an
 * approved dry-run. This command is never run automatically at deploy/startup.
 */
import 'dotenv/config';
import { prisma } from '@/lib/prisma/client';
import { cleanupLegacyGapAnalysisPayloads } from '@/modules/ai-jobs/gap-analysis-payload-cleanup';

function printSummary(summary: Awaited<ReturnType<typeof cleanupLegacyGapAnalysisPayloads>>): void {
  const status = (name: string) => summary.statusCounts[name] ?? 0;
  console.log('Gap Analysis AiJob payload cleanup');
  console.log(`Mode: ${summary.dryRun ? 'DRY RUN' : 'EXECUTE'}`);
  console.log(`Rows inspected: ${summary.rowsInspected}`);
  console.log(`Legacy payloads detected: ${summary.legacyPayloadsDetected}`);
  console.log(`Terminal and safe to scrub: ${summary.terminalAndSafeToScrub}`);
  console.log(`Active/retryable retained: ${summary.activeOrRetryable}`);
  console.log(`Active with supported fileContent fallback: ${summary.activeWithSupportedFileContentFallback}`);
  console.log(`Active with unsupported legacy shape: ${summary.activeWithUnsupportedLegacyShape}`);
  console.log(`Unknown-status retained: ${summary.unknownStatus}`);
  console.log(`Already clean: ${summary.alreadyClean}`);
  console.log(`Rows scrubbed: ${summary.rowsScrubbed}`);
  console.log(`QUEUED: ${status('QUEUED')}`);
  console.log(`RUNNING: ${status('RUNNING')}`);
  console.log(`RETRYABLE: ${status('RETRYING')}`);
  console.log(`COMPLETED: ${status('COMPLETED')}`);
  console.log(`FAILED: ${status('FAILED') + status('DEAD_LETTERED')}`);
  console.log(`CANCELLED: ${status('CANCELLED')}`);
  console.log(`Fields detected: fileContent=${summary.fieldCounts.fileContent}, base64=${summary.fieldCounts.base64}, fileBuffer=${summary.fieldCounts.fileBuffer}, rawText=${summary.fieldCounts.rawText}`);
  console.log('Documents printed: 0');
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const production = process.env.DATABASE_ENVIRONMENT === 'production';
  if (execute && production && !process.argv.includes('--confirm-production')) {
    throw new Error('Production execution requires --execute --confirm-production after an approved dry-run.');
  }

  const summary = await cleanupLegacyGapAnalysisPayloads(prisma as any, { execute });
  printSummary(summary);
}

main()
  .catch(() => {
    console.error('Cleanup failed. No rows were reported; review protected application logs for the database error.');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
