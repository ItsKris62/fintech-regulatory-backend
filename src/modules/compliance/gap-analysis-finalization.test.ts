import { describe, expect, it, vi } from "vitest";
import { AiJobLeaseLostError } from "@/modules/ai-jobs/ai-job-lease";
import { GapAnalysisCancelledError } from "./gap-analysis-cancellation";
import {
  finalizeGapAnalysisAttempt,
  GAP_ANALYSIS_ACTIVE_STATUSES,
} from "./gap-analysis-finalization";

const execution = { jobId: "job-1", workerId: "worker-b", attempt: 2 };
const completedAt = new Date("2026-10-19T12:00:00.000Z");

function tx(gapCount = 1, jobCount = 1) {
  const gapUpdateMany = vi.fn().mockResolvedValue({ count: gapCount });
  const ledgerUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const jobUpdateMany = vi.fn().mockResolvedValue({ count: jobCount });
  return {
    client: {
      gapAnalysis: { updateMany: gapUpdateMany },
      gapAnalysisUsageLedger: { updateMany: ledgerUpdateMany },
      aiJob: { updateMany: jobUpdateMany },
    } as any,
    gapUpdateMany,
    ledgerUpdateMany,
    jobUpdateMany,
  };
}

const params = {
  analysisId: "ga-1",
  userId: "user-1",
  organizationId: "org-1",
  execution,
  completedAt,
  analysisData: { status: "COMPLETED", progress: 100 },
};

describe("Gap Analysis fenced atomic finalization", () => {
  it("binds result completion to tenant, active analysis state, owner, and fencing token", async () => {
    const mocks = tx();

    await expect(
      finalizeGapAnalysisAttempt(mocks.client, params),
    ).resolves.toBeUndefined();
    expect(mocks.gapUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "ga-1",
        userId: "user-1",
        organizationId: "org-1",
        deletedAt: null,
        status: { in: [...GAP_ANALYSIS_ACTIVE_STATUSES] },
      },
      data: params.analysisData,
    });
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "job-1",
          status: "RUNNING",
          lockedBy: "worker-b",
          attempts: 2,
          targetEntityType: "GapAnalysis",
          targetEntityId: "ga-1",
          userId: "user-1",
          organizationId: "org-1",
        }),
      }),
    );
    expect(mocks.ledgerUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          analysisId: "ga-1",
          state: "RESERVED",
        }),
        data: { state: "SETTLED", settledAt: completedAt, lastError: null },
      }),
    );
  });

  it("fences a stale worker after a newer attempt owns the job", async () => {
    const mocks = tx(1, 0);

    await expect(
      finalizeGapAnalysisAttempt(mocks.client, params),
    ).rejects.toBeInstanceOf(AiJobLeaseLostError);
  });

  it("cannot overwrite cancellation or another terminal analysis state", async () => {
    const mocks = tx(0, 1);

    await expect(
      finalizeGapAnalysisAttempt(mocks.client, params),
    ).rejects.toBeInstanceOf(GapAnalysisCancelledError);
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
  });
});
