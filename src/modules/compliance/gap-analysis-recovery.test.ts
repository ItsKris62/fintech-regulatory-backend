import { describe, expect, it, vi } from "vitest";
import {
  GAP_ANALYSIS_ABANDONMENT_GRACE_MS,
  gapAnalysisRecoveryDeadlineMs,
  recoverAbandonedGapAnalyses,
} from "./gap-analysis-recovery";

const NOW = new Date("2026-10-19T12:00:00.000Z");

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    id: "ga-1",
    userId: "user-1",
    organizationId: "org-1",
    analysisDepth: "deep",
    status: "ANALYZING",
    updatedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    ...overrides,
  };
}

function recoveryDb(rows: any[], job: any) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const findFirst = vi.fn().mockResolvedValue(job);
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  return {
    db: { gapAnalysis: { findMany, updateMany }, aiJob: { findFirst } } as any,
    findMany,
    findFirst,
    updateMany,
  };
}

describe("Gap Analysis depth-aware abandoned execution recovery", () => {
  it("keeps Standard and Deep deadlines distinct and adds bounded abandonment grace", () => {
    expect(gapAnalysisRecoveryDeadlineMs("standard")).toBe(
      20 * 60 * 1000 + GAP_ANALYSIS_ABANDONMENT_GRACE_MS,
    );
    expect(gapAnalysisRecoveryDeadlineMs("deep")).toBe(
      35 * 60 * 1000 + GAP_ANALYSIS_ABANDONMENT_GRACE_MS,
    );
  });

  it("does not fail Deep merely because it crossed the former global 20-minute threshold", async () => {
    const row = analysis({
      updatedAt: new Date(NOW.getTime() - 25 * 60 * 1000),
    });
    const mocks = recoveryDb([row], null);

    await expect(recoverAbandonedGapAnalyses(NOW, mocks.db)).resolves.toBe(0);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("does not reclassify Standard after the former 15-minute lock age", async () => {
    const row = analysis({
      analysisDepth: "standard",
      updatedAt: new Date(NOW.getTime() - 16 * 60 * 1000),
    });
    const mocks = recoveryDb([row], {
      id: "job-1",
      status: "RUNNING",
      attempts: 1,
    });

    await expect(recoverAbandonedGapAnalyses(NOW, mocks.db)).resolves.toBe(0);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it.each(["QUEUED", "RUNNING", "RETRYING"])(
    "never fails an old analysis while its durable job is %s",
    async (status) => {
      const mocks = recoveryDb([analysis()], {
        id: "job-1",
        status,
        attempts: 2,
      });

      await expect(recoverAbandonedGapAnalyses(NOW, mocks.db)).resolves.toBe(0);
      expect(mocks.updateMany).not.toHaveBeenCalled();
    },
  );

  it("recovers a genuinely abandoned analysis only after its depth deadline and grace", async () => {
    const row = analysis();
    const mocks = recoveryDb([row], null);

    await expect(recoverAbandonedGapAnalyses(NOW, mocks.db)).resolves.toBe(1);
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          targetEntityId: "ga-1",
          userId: "user-1",
          organizationId: "org-1",
        }),
      }),
    );
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "ga-1",
          userId: "user-1",
          organizationId: "org-1",
          status: "ANALYZING",
        }),
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
  });

  it("preserves terminal cancellation when reconciling an abandoned cancelled job", async () => {
    const mocks = recoveryDb([analysis()], {
      id: "job-1",
      status: "CANCELLED",
      attempts: 1,
    });

    await expect(recoverAbandonedGapAnalyses(NOW, mocks.db)).resolves.toBe(1);
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "CANCELLED" },
      }),
    );
  });
});
