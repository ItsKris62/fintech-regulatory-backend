import { afterEach, describe, expect, it, vi } from "vitest";

const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/redis/client", () => ({ redis }));
vi.mock("@/utils/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

import { AIProviderFailure } from "@/lib/ai/provider-failure";
import {
  getGapAnalysisProviderReadiness,
  recordGapAnalysisProviderFailure,
} from "./gap-analysis-provider-readiness";

describe("Gap Analysis provider readiness", () => {
  const original = process.env.GAP_ANALYSIS_AI_AVAILABILITY;
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    vi.clearAllMocks();
    if (original === undefined) delete process.env.GAP_ANALYSIS_AI_AVAILABILITY;
    else process.env.GAP_ANALYSIS_AI_AVAILABILITY = original;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("fails closed when availability has not been explicitly verified", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.GAP_ANALYSIS_AI_AVAILABILITY;
    redis.get.mockResolvedValue(null);
    await expect(getGapAnalysisProviderReadiness()).resolves.toMatchObject({
      state: "UNKNOWN",
      reason: "NOT_VERIFIED",
    });
  });

  it("uses a cached nonretryable billing failure to gate new work", async () => {
    process.env.GAP_ANALYSIS_AI_AVAILABILITY = "AVAILABLE";
    redis.get.mockResolvedValue({
      state: "UNAVAILABLE",
      provider: "anthropic",
      reason: "BILLING",
      retryAfter: "2026-10-19T12:00:00.000Z",
    });
    await expect(getGapAnalysisProviderReadiness()).resolves.toMatchObject({
      state: "UNAVAILABLE",
      reason: "BILLING",
      source: "CACHED_FAILURE",
    });
  });

  it("opens a scoped circuit without a provider probe", async () => {
    redis.set.mockResolvedValue("OK");
    await recordGapAnalysisProviderFailure(
      new AIProviderFailure({
        provider: "anthropic",
        category: "BILLING",
        retryable: false,
      }),
    );
    expect(redis.set).toHaveBeenCalledWith(
      "sheriabot:gap-analysis:provider-readiness:anthropic",
      expect.objectContaining({ state: "UNAVAILABLE", reason: "BILLING" }),
      { ex: 60 * 60 },
    );
  });
});
