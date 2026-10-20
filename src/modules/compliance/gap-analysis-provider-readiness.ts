import { redis } from "@/lib/redis/client";
import { logger } from "@/utils/logger";
import type {
  AIProviderFailure,
  AIProviderFailureCategory,
} from "@/lib/ai/provider-failure";

export type GapAnalysisProviderReadinessState =
  "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";

export interface GapAnalysisProviderReadiness {
  state: GapAnalysisProviderReadinessState;
  provider: "anthropic";
  reason?: AIProviderFailureCategory | "OPERATOR_DISABLED" | "NOT_VERIFIED";
  retryAfter?: string;
  source: "OPERATOR" | "CACHED_FAILURE" | "DEFAULT";
}

const READINESS_KEY = "sheriabot:gap-analysis:provider-readiness:anthropic";
const TRANSIENT_TTL_SECONDS = 5 * 60;
const NON_RETRYABLE_TTL_SECONDS = 60 * 60;

function configuredState(): GapAnalysisProviderReadinessState {
  const raw = process.env.GAP_ANALYSIS_AI_AVAILABILITY?.trim().toUpperCase();
  if (raw === "AVAILABLE" || raw === "UNAVAILABLE" || raw === "UNKNOWN")
    return raw;
  // Tests must opt into provider calls through mocks; production-like runtimes
  // fail closed until an operator explicitly records availability.
  return process.env.NODE_ENV === "test" ? "AVAILABLE" : "UNKNOWN";
}

export async function getGapAnalysisProviderReadiness(): Promise<GapAnalysisProviderReadiness> {
  const operationalState = configuredState();
  if (operationalState === "UNAVAILABLE") {
    return {
      state: "UNAVAILABLE",
      provider: "anthropic",
      reason: "OPERATOR_DISABLED",
      source: "OPERATOR",
    };
  }

  try {
    const cached = await redis.get<GapAnalysisProviderReadiness>(READINESS_KEY);
    if (cached?.state === "UNAVAILABLE")
      return { ...cached, source: "CACHED_FAILURE" };
  } catch (error) {
    logger.warn({
      type: "gap_analysis_provider_readiness_cache_error",
      provider: "anthropic",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (operationalState === "AVAILABLE") {
    return { state: "AVAILABLE", provider: "anthropic", source: "OPERATOR" };
  }
  return {
    state: "UNKNOWN",
    provider: "anthropic",
    reason: "NOT_VERIFIED",
    source: "DEFAULT",
  };
}

export async function recordGapAnalysisProviderFailure(
  failure: AIProviderFailure,
): Promise<void> {
  if (failure.provider !== "anthropic") return;
  const shouldOpen = [
    "BILLING",
    "AUTHENTICATION",
    "RATE_LIMIT",
    "UNAVAILABLE",
    "TIMEOUT",
    "NETWORK",
  ].includes(failure.category);
  if (!shouldOpen) return;
  const ttl = failure.retryable
    ? TRANSIENT_TTL_SECONDS
    : NON_RETRYABLE_TTL_SECONDS;
  const retryAfter = new Date(Date.now() + ttl * 1000).toISOString();
  const readiness: GapAnalysisProviderReadiness = {
    state: "UNAVAILABLE",
    provider: "anthropic",
    reason: failure.category,
    retryAfter,
    source: "CACHED_FAILURE",
  };
  try {
    await redis.set(READINESS_KEY, readiness, { ex: ttl });
  } catch (error) {
    logger.error({
      type: "gap_analysis_provider_readiness_record_failed",
      provider: "anthropic",
      failureCategory: failure.category,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function clearGapAnalysisProviderFailure(): Promise<void> {
  await redis.del(READINESS_KEY);
}
