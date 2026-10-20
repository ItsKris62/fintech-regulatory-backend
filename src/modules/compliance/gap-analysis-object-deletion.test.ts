import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  gapAnalysisObjectDeletion: { upsert: vi.fn(), updateMany: vi.fn() },
  gapAnalysis: { findFirst: vi.fn() },
  auditLog: { create: vi.fn() },
  $queryRaw: vi.fn(),
}));
const deleteFile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma/client", () => ({ prisma }));
vi.mock("@/lib/storage/storage.service", () => ({
  storageService: { deleteFile },
}));
vi.mock("@/utils/logger", () => ({ logger: { info: vi.fn() } }));

import {
  enqueueGapAnalysisObjectDeletion,
  processGapAnalysisObjectDeletionBatch,
} from "./gap-analysis-object-deletion";

describe("Gap Analysis object deletion outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.gapAnalysisObjectDeletion.upsert.mockResolvedValue({});
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.auditLog.create.mockResolvedValue({});
  });

  it("rejects a source object outside the tenant/analysis prefix", async () => {
    await expect(
      enqueueGapAnalysisObjectDeletion({
        analysisId: "analysis-a",
        organizationId: "org-a",
        userId: "user-a",
        objectKey: "gap-analysis/org-b/analysis-a/file.pdf",
        objectType: "SOURCE",
        reason: "EXPLICIT_DELETE",
      }),
    ).rejects.toThrow("outside the analysis-owned storage prefix");
    expect(prisma.gapAnalysisObjectDeletion.upsert).not.toHaveBeenCalled();
  });

  it("persists a canonical source deletion intent idempotently", async () => {
    await enqueueGapAnalysisObjectDeletion({
      analysisId: "analysis-a",
      organizationId: "org-a",
      userId: "user-a",
      objectKey: "gap-analysis/org-a/analysis-a/file.pdf",
      objectType: "SOURCE",
      reason: "EXPLICIT_DELETE",
    });
    expect(prisma.gapAnalysisObjectDeletion.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          analysisId_objectKey: {
            analysisId: "analysis-a",
            objectKey: "gap-analysis/org-a/analysis-a/file.pdf",
          },
        },
      }),
    );
  });

  it("never deletes when the deleted analysis ownership/key check fails", async () => {
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        id: "outbox-a",
        analysisId: "analysis-a",
        organizationId: "org-a",
        userId: "user-a",
        objectKey: "gap-analysis/org-a/analysis-a/file.pdf",
        objectType: "SOURCE",
        reason: "EXPLICIT_DELETE",
        attempts: 1,
        maxAttempts: 8,
      },
    ]);
    prisma.gapAnalysis.findFirst.mockResolvedValue(null);
    prisma.gapAnalysisObjectDeletion.updateMany.mockResolvedValue({ count: 1 });
    await expect(processGapAnalysisObjectDeletionBatch(1)).resolves.toEqual({
      completed: 0,
      failed: 0,
      skipped: 1,
    });
    expect(deleteFile).not.toHaveBeenCalled();
    expect(prisma.gapAnalysisObjectDeletion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ESCALATED" }),
      }),
    );
  });
});
