/**
 * Backfill script for per-tenant AI costs (USD & KES) in UsageRecord.
 *
 * Idempotent: Only updates rows where costUsd is null or costKes is null.
 * Uses historical token estimations with a clear pricingVersion = 'estimated_backfill_v1'.
 *
 * Run with: npx tsx scripts/backfill-tenant-costs.ts
 */

import { PrismaClient, BillingMetric } from '@prisma/client';
import { calculateCostWithFx } from '../src/lib/ai/gateway/pricing';

const prisma = new PrismaClient();

const METRIC_TOKEN_ESTIMATES: Record<BillingMetric, { inputTokens: number; outputTokens: number; model: string }> = {
  [BillingMetric.COMPLIANCE_QUERIES]: { inputTokens: 1200, outputTokens: 600, model: 'claude-sonnet-4-6' },
  [BillingMetric.CHECKLIST_GENERATIONS]: { inputTokens: 2000, outputTokens: 2500, model: 'claude-sonnet-4-6' },
  [BillingMetric.GAP_ANALYSES]: { inputTokens: 3500, outputTokens: 2000, model: 'claude-sonnet-4-6' },
  [BillingMetric.POLICY_GENERATIONS]: { inputTokens: 4000, outputTokens: 4000, model: 'claude-sonnet-4-6' },
  [BillingMetric.API_CALLS]: { inputTokens: 800, outputTokens: 400, model: 'claude-haiku-4-5-20251001' },
  [BillingMetric.DOCUMENT_STORAGE_MB]: { inputTokens: 0, outputTokens: 0, model: 'claude-sonnet-4-6' },
};

export async function backfillTenantCosts(): Promise<{ processed: number; updated: number }> {
  console.log('Starting per-tenant AI cost backfill...');

  const recordsToBackfill = await prisma.usageRecord.findMany({
    where: {
      OR: [
        { costUsd: null },
        { costKes: null },
      ],
    },
  });

  console.log(`Found ${recordsToBackfill.length} records requiring backfill.`);
  let updatedCount = 0;

  for (const record of recordsToBackfill) {
    const estimates = METRIC_TOKEN_ESTIMATES[record.metric] ?? { inputTokens: 1000, outputTokens: 500, model: 'claude-sonnet-4-6' };
    const totalInputTokens = estimates.inputTokens * record.count;
    const totalOutputTokens = estimates.outputTokens * record.count;

    const costDetails = await calculateCostWithFx(
      'anthropic',
      estimates.model,
      totalInputTokens,
      totalOutputTokens
    );

    await prisma.usageRecord.update({
      where: { id: record.id },
      data: {
        costUsd: costDetails.costUsd,
        costKes: costDetails.costKes,
        fxRateUsdToKes: costDetails.fxRateUsdToKes,
        fxRateCapturedAt: record.createdAt,
        pricingVersion: 'estimated_backfill_v1',
      },
    });

    updatedCount++;
  }

  console.log(`Successfully backfilled ${updatedCount} usage records.`);
  return { processed: recordsToBackfill.length, updated: updatedCount };
}

if (require.main === module) {
  backfillTenantCosts()
    .then(() => {
      console.log('Backfill finished.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Backfill error:', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
