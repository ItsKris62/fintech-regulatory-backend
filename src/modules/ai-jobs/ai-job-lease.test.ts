import { describe, expect, it, vi } from "vitest";
import {
  AiJobLeaseLostError,
  aiJobLeaseWhere,
  assertAiJobLeaseOwned,
  renewAiJobLease,
  type AiJobExecutionLease,
} from "./ai-job-lease";

const current: AiJobExecutionLease = {
  jobId: "job-1",
  workerId: "worker-b",
  attempt: 2,
};
const stale: AiJobExecutionLease = {
  jobId: "job-1",
  workerId: "worker-a",
  attempt: 1,
};

function leaseDb(owner = current) {
  const updateMany = vi.fn(async ({ where }: any) => ({
    count:
      where.id === owner.jobId &&
      where.status === "RUNNING" &&
      where.lockedBy === owner.workerId &&
      where.attempts === owner.attempt
        ? 1
        : 0,
  }));
  const findFirst = vi.fn(async ({ where }: any) =>
    where.id === owner.jobId &&
    where.status === "RUNNING" &&
    where.lockedBy === owner.workerId &&
    where.attempts === owner.attempt
      ? { id: owner.jobId }
      : null,
  );
  return { aiJob: { updateMany, findFirst } } as any;
}

describe("AiJob renewable fenced leases", () => {
  it("uses the atomic claim attempt as a monotonically increasing fencing token", () => {
    expect(aiJobLeaseWhere(current)).toEqual({
      id: "job-1",
      status: "RUNNING",
      lockedBy: "worker-b",
      attempts: 2,
    });
  });

  it("renews only the authoritative owner heartbeat", async () => {
    const db = leaseDb();
    const now = new Date("2026-10-19T12:00:00.000Z");

    await expect(renewAiJobLease(current, now, db)).resolves.toBeUndefined();
    expect(db.aiJob.updateMany).toHaveBeenCalledWith({
      where: aiJobLeaseWhere(current),
      data: { lockedAt: now },
    });
  });

  it("rejects heartbeat renewal from an outdated attempt after reclaim", async () => {
    await expect(
      renewAiJobLease(stale, new Date(), leaseDb()),
    ).rejects.toBeInstanceOf(AiJobLeaseLostError);
  });

  it("prevents a stale worker from reasserting ownership after a newer claim", async () => {
    const db = leaseDb();

    await expect(assertAiJobLeaseOwned(current, db)).resolves.toBeUndefined();
    await expect(assertAiJobLeaseOwned(stale, db)).rejects.toBeInstanceOf(
      AiJobLeaseLostError,
    );
  });
});
