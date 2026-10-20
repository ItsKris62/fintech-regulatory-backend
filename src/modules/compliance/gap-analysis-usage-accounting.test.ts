import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  gapAnalysisUsageLedger: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
  $transaction: vi.fn(),
}));
const redis = vi.hoisted(() => ({ eval: vi.fn() }));
const decrementTrialUsageAtomic = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma/client", () => ({ prisma }));
vi.mock("@/lib/redis/client", () => ({ redis }));
vi.mock("@/modules/trial", () => ({ decrementTrialUsageAtomic }));
vi.mock("@/utils/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { compensateGapAnalysisUsage } from "./gap-analysis-usage-accounting";

const ledger = {
  id: "ledger-1",
  analysisId: "analysis-1",
  organizationId: "org-1",
  userId: "user-1",
  scope: "REDIS",
  units: 2,
  counterKey: "sheriabot:usage:org-1:GAP_ANALYSES:2026-10",
  reservationKey: "execution-1",
  state: "RESERVED",
};

describe("Gap Analysis usage compensation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.gapAnalysisUsageLedger.findFirst.mockResolvedValue(ledger);
    prisma.gapAnalysisUsageLedger.updateMany.mockResolvedValue({ count: 1 });
    prisma.gapAnalysisUsageLedger.update.mockResolvedValue({});
    redis.eval.mockResolvedValue(1);
  });

  it("uses one per-ledger Redis marker before releasing a Redis reservation", async () => {
    await expect(
      compensateGapAnalysisUsage({
        analysisId: "analysis-1",
        organizationId: "org-1",
        userId: "user-1",
        failureClass: "BILLING",
      }),
    ).resolves.toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("EXISTS"),
      [ledger.counterKey, "sheriabot:gap-analysis:usage-refund:ledger-1"],
      ["2", String(45 * 24 * 60 * 60)],
    );
    expect(prisma.gapAnalysisUsageLedger.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "RELEASED" }),
      }),
    );
  });

  it("does not refund an already released reservation", async () => {
    prisma.gapAnalysisUsageLedger.findFirst.mockResolvedValue({
      ...ledger,
      state: "RELEASED",
    });
    await expect(
      compensateGapAnalysisUsage({
        analysisId: "analysis-1",
        organizationId: "org-1",
        userId: "user-1",
        failureClass: "BILLING",
      }),
    ).resolves.toBe(true);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("keeps a failed compensation durable and pending for reconciliation", async () => {
    redis.eval.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(
      compensateGapAnalysisUsage({
        analysisId: "analysis-1",
        organizationId: "org-1",
        userId: "user-1",
        failureClass: "UNAVAILABLE",
      }),
    ).rejects.toThrow("redis unavailable");
    expect(prisma.gapAnalysisUsageLedger.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "COMPENSATION_PENDING" }),
      }),
    );
  });
});
