import os from "os";
import { prisma } from "@/lib/prisma/client";
import { storageService } from "@/lib/storage/storage.service";
import { logger } from "@/utils/logger";
import { GAP_ANALYSIS_STORAGE_PATH_PREFIX } from "@/config/gap-analysis.config";

const WORKER_ID = `${os.hostname()}:${process.pid}:gap-object-cleanup`;
const MAX_BATCH = 50;
const LOCK_STALE_MS = 10 * 60 * 1000;

type ClaimedDeletion = {
  id: string;
  analysisId: string;
  organizationId: string;
  userId: string;
  objectKey: string;
  objectType: string;
  reason: string;
  attempts: number;
  maxAttempts: number;
};

function retryDelay(attempt: number): number {
  const base = Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempt - 1));
  return base + Math.floor(Math.random() * Math.min(15_000, base / 4));
}

function sourceKeyIsOwned(
  key: string,
  organizationId: string,
  analysisId: string,
): boolean {
  const partition = organizationId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return (
    key.startsWith(
      `${GAP_ANALYSIS_STORAGE_PATH_PREFIX}${partition}/${analysisId}/`,
    ) && !key.includes("..")
  );
}

function reportKeyIsOwned(
  key: string,
  organizationId: string,
  analysisId: string,
): boolean {
  return (
    (key.startsWith(`gap-analysis-exports/${organizationId}/${analysisId}/`) ||
      key.startsWith("reports/")) &&
    !key.includes("..")
  );
}

export async function enqueueGapAnalysisObjectDeletion(input: {
  analysisId: string;
  organizationId: string;
  userId: string;
  objectKey: string;
  objectType: "SOURCE" | "REPORT";
  reason: string;
  runAfter?: Date;
}): Promise<void> {
  const owned =
    input.objectType === "SOURCE"
      ? sourceKeyIsOwned(
          input.objectKey,
          input.organizationId,
          input.analysisId,
        )
      : reportKeyIsOwned(
          input.objectKey,
          input.organizationId,
          input.analysisId,
        );
  if (!owned)
    throw new Error(
      "Refusing to enqueue an object outside the analysis-owned storage prefix.",
    );
  await prisma.gapAnalysisObjectDeletion.upsert({
    where: {
      analysisId_objectKey: {
        analysisId: input.analysisId,
        objectKey: input.objectKey,
      },
    },
    create: {
      ...input,
      status: "PENDING",
      runAfter: input.runAfter ?? new Date(),
    },
    update: {},
  });
}

async function claimNextDeletion(): Promise<ClaimedDeletion | null> {
  const rows = await prisma.$queryRaw<ClaimedDeletion[]>`
    UPDATE "GapAnalysisObjectDeletion"
    SET "status" = 'PROCESSING', "lockedAt" = NOW(), "lockedBy" = ${WORKER_ID},
        "attempts" = "attempts" + 1, "updatedAt" = NOW()
    WHERE "id" = (
      SELECT "id" FROM "GapAnalysisObjectDeletion"
      WHERE "status" IN ('PENDING', 'RETRYING') AND "runAfter" <= NOW()
      ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING "id", "analysisId", "organizationId", "userId", "objectKey", "objectType", "reason", "attempts", "maxAttempts"
  `;
  return rows[0] ?? null;
}

async function completeDeletion(row: ClaimedDeletion): Promise<void> {
  const updated = await prisma.gapAnalysisObjectDeletion.updateMany({
    where: { id: row.id, status: "PROCESSING", lockedBy: WORKER_ID },
    data: {
      status: "COMPLETED",
      completedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    },
  });
  if (updated.count !== 1) return;
  await prisma.auditLog
    .create({
      data: {
        userId: row.userId,
        action: "GAP_ANALYSIS_OBJECT_DELETION_COMPLETED",
        entityType: "GapAnalysis",
        entityId: row.analysisId,
        metadata: {
          objectType: row.objectType,
          reason: row.reason,
          outboxId: row.id,
        },
        ipAddress: null,
        userAgent: null,
      },
    })
    .catch(() => undefined);
}

async function failDeletion(
  row: ClaimedDeletion,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = row.attempts >= row.maxAttempts;
  await prisma.gapAnalysisObjectDeletion.updateMany({
    where: { id: row.id, status: "PROCESSING", lockedBy: WORKER_ID },
    data: exhausted
      ? {
          status: "ESCALATED",
          escalatedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: message,
        }
      : {
          status: "RETRYING",
          runAfter: new Date(Date.now() + retryDelay(row.attempts)),
          lockedAt: null,
          lockedBy: null,
          lastError: message,
        },
  });
}

export async function processGapAnalysisObjectDeletionBatch(
  limit = 10,
): Promise<{ completed: number; failed: number; skipped: number }> {
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  for (
    let index = 0;
    index < Math.min(Math.max(limit, 1), MAX_BATCH);
    index++
  ) {
    const row = await claimNextDeletion();
    if (!row) break;
    try {
      const analysis = await prisma.gapAnalysis.findFirst({
        where: {
          id: row.analysisId,
          organizationId: row.organizationId,
          userId: row.userId,
          deletedAt: { not: null },
        },
        select: { documentUrl: true, reportUrl: true },
      });
      const expectedKey =
        row.objectType === "SOURCE"
          ? analysis?.documentUrl
          : analysis?.reportUrl;
      const owned =
        row.objectType === "SOURCE"
          ? sourceKeyIsOwned(row.objectKey, row.organizationId, row.analysisId)
          : reportKeyIsOwned(row.objectKey, row.organizationId, row.analysisId);
      if (!analysis || expectedKey !== row.objectKey || !owned) {
        await prisma.gapAnalysisObjectDeletion.updateMany({
          where: { id: row.id, status: "PROCESSING", lockedBy: WORKER_ID },
          data: {
            status: "ESCALATED",
            escalatedAt: new Date(),
            lockedAt: null,
            lockedBy: null,
            lastError: "Ownership or deleted-analysis validation failed.",
          },
        });
        skipped++;
        continue;
      }
      await storageService.deleteFile(row.objectKey);
      await completeDeletion(row);
      completed++;
    } catch (error) {
      await failDeletion(row, error);
      failed++;
    }
  }
  logger.info({
    type: "gap_analysis_object_deletion_batch_complete",
    completed,
    failed,
    skipped,
  });
  return { completed, failed, skipped };
}

export async function recoverStaleGapAnalysisObjectDeletionClaims(): Promise<number> {
  const stale = new Date(Date.now() - LOCK_STALE_MS);
  const result = await prisma.gapAnalysisObjectDeletion.updateMany({
    where: { status: "PROCESSING", lockedAt: { lt: stale } },
    data: {
      status: "RETRYING",
      lockedAt: null,
      lockedBy: null,
      runAfter: new Date(),
    },
  });
  return result.count;
}
