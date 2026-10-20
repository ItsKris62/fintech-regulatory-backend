import "dotenv/config";
import { prisma } from "@/lib/prisma/client";
import { processGapAnalysisObjectDeletionBatch } from "@/modules/compliance/gap-analysis-object-deletion";
import { logger } from "@/utils/logger";

function option(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  return Number.isInteger(value) ? Math.min(Math.max(value, 1), 50) : fallback;
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const limit = option("--limit", 10);
  const candidates = await prisma.gapAnalysisObjectDeletion.findMany({
    where: {
      status: { in: ["PENDING", "RETRYING", "PROCESSING", "ESCALATED"] },
    },
    take: limit,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      analysisId: true,
      organizationId: true,
      objectType: true,
      status: true,
      attempts: true,
    },
  });
  if (!execute) {
    logger.info({
      type: "gap_analysis_object_reconciliation_dry_run",
      limit,
      candidates: candidates.length,
      statuses: candidates.map((row) => row.status),
    });
    return;
  }
  const summary = await processGapAnalysisObjectDeletionBatch(limit);
  logger.info({
    type: "gap_analysis_object_reconciliation_complete",
    limit,
    candidates: candidates.length,
    ...summary,
  });
  if (summary.failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  logger.error({
    type: "gap_analysis_object_reconciliation_failed",
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
