import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(__dirname, "ai-job-runner.ts"), "utf8");

describe("AiJob runner ownership contract", () => {
  it("claims one eligible job atomically and increments the fencing generation", () => {
    expect(source).toContain("FOR UPDATE SKIP LOCKED");
    expect(source).toContain('"attempts" = "attempts" + 1');
    expect(source).toContain("LIMIT 1");
  });

  it("renews the lease while handlers run and fences progress writes", () => {
    expect(source).toContain("renewAiJobLease(lease)");
    expect(source).toContain("where: aiJobLeaseWhere(lease)");
    expect(source).toContain("data: { progress, lockedAt: new Date() }");
  });

  it("uses the same owner-generation predicate for completion, cancellation, and failure", () => {
    const uses = source.match(/where: aiJobLeaseWhere\(lease\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain("type: 'ai_job_stale_attempt_fenced'");
    expect(source).toContain("type: 'ai_job_failure_transition_fenced'");
  });

  it("passes the complete lease identity into Gap Analysis execution", () => {
    expect(source).toContain(
      "await executeGapAnalysisPipeline(job.payload as never, lease)",
    );
  });

  it("retains bounded crash recovery based on an unrenewed heartbeat", () => {
    expect(source).toContain("lockedAt: { lt: staleBefore }");
    expect(source).toContain("status: 'RETRYING'");
    expect(source).toContain(
      "lastError: 'Worker lock expired before completion.'",
    );
  });

  it("retains bounded retry exhaustion and dead-letter handling", () => {
    expect(source).toContain("job.attempts >= job.maxAttempts");
    expect(source).toContain(
      "status: exhausted ? 'DEAD_LETTERED' : 'RETRYING'",
    );
    expect(source).toContain("exhausted ? 'DEAD_LETTERED' : 'RETRY_SCHEDULED'");
  });
});
