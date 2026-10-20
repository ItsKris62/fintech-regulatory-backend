import { reconcilePendingGapAnalysisUsage } from "@/modules/compliance/gap-analysis-usage-accounting";
import { prisma } from "@/lib/prisma/client";
import { logger } from "@/utils/logger";

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const rawLimit = Number(process.argv[process.argv.indexOf("--limit") + 1]);
  const limit = Number.isInteger(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 500)
    : 100;
  if (!execute) {
    const pending = await prisma.gapAnalysisUsageLedger.count({
      where: { state: "COMPENSATION_PENDING" },
    });
    logger.info({
      type: "gap_analysis_usage_reconciliation_dry_run",
      limit,
      pending,
    });
    return;
  }
  const result = await reconcilePendingGapAnalysisUsage(limit);
  logger.info({
    type: "gap_analysis_usage_reconciliation_complete",
    limit,
    ...result,
  });
  if (result.failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  logger.error({
    type: "gap_analysis_usage_reconciliation_failed",
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
