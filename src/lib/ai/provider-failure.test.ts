import { describe, expect, it } from "vitest";
import { LLMProviderError } from "./gateway/types";
import { normalizeAIProviderFailure } from "./provider-failure";

describe("AI provider failure normalization", () => {
  it.each([
    [402, "credit balance is too low", "BILLING", false],
    [401, "invalid API key", "AUTHENTICATION", false],
    [429, "rate limit exceeded", "RATE_LIMIT", true],
    [503, "overloaded", "UNAVAILABLE", true],
    [408, "request timed out", "TIMEOUT", true],
    [413, "context length exceeded", "CONTEXT_LIMIT", false],
  ] as const)(
    "classifies provider status %s as %s",
    (status, message, category, retryable) => {
      const failure = normalizeAIProviderFailure(
        new LLMProviderError("anthropic", message, status, retryable),
      );
      expect(failure.category).toBe(category);
      expect(failure.retryable).toBe(retryable);
      expect(failure.message).not.toContain(message);
    },
  );

  it("classifies a network failure without exposing upstream details", () => {
    const failure = normalizeAIProviderFailure(
      new Error("fetch failed: ECONNRESET token=secret"),
    );
    expect(failure.category).toBe("NETWORK");
    expect(failure.message).not.toContain("secret");
  });
});
