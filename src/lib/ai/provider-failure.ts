import { AIServiceError } from "@/utils/error";
import {
  LLMProviderError,
  LLMProviderNotConfiguredError,
} from "./gateway/types";

export type AIProviderFailureCategory =
  | "BILLING"
  | "AUTHENTICATION"
  | "RATE_LIMIT"
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "NETWORK"
  | "CONTEXT_LIMIT"
  | "INVALID_OUTPUT"
  | "INTERNAL";

const SAFE_MESSAGES: Record<AIProviderFailureCategory, string> = {
  BILLING:
    "AI analysis is temporarily unavailable. Please contact support before retrying.",
  AUTHENTICATION:
    "AI analysis is temporarily unavailable. Please contact support before retrying.",
  RATE_LIMIT: "AI analysis is temporarily busy. Please try again later.",
  UNAVAILABLE:
    "AI analysis is temporarily unavailable. Please try again later.",
  TIMEOUT: "The AI analysis service timed out. Please try again later.",
  NETWORK:
    "The AI analysis service could not be reached. Please try again later.",
  CONTEXT_LIMIT:
    "The document exceeds the AI analysis context limit. Try a smaller document.",
  INVALID_OUTPUT:
    "The AI analysis service returned an invalid response. Please try again later.",
  INTERNAL:
    "The AI analysis service could not complete this request. Please try again later.",
};

export class AIProviderFailure extends AIServiceError {
  readonly provider: string;
  readonly category: AIProviderFailureCategory;
  readonly providerStatus?: number;
  readonly retryable: boolean;

  constructor(input: {
    provider: string;
    category: AIProviderFailureCategory;
    status?: number;
    retryable: boolean;
  }) {
    super(SAFE_MESSAGES[input.category], {
      provider: input.provider,
      providerFailureCategory: input.category,
      providerStatus: input.status,
      retryable: input.retryable,
    });
    this.provider = input.provider;
    this.category = input.category;
    this.providerStatus = input.status;
    this.retryable = input.retryable;
  }
}

function classifyMessage(
  message: string,
  status?: number,
): AIProviderFailureCategory {
  if (
    status === 402 ||
    /credit balance|purchase credits|insufficient credit|billing/i.test(message)
  )
    return "BILLING";
  if (
    status === 401 ||
    status === 403 ||
    /invalid api key|authentication|unauthorized/i.test(message)
  )
    return "AUTHENTICATION";
  if (status === 429 || /rate.?limit|too many requests/i.test(message))
    return "RATE_LIMIT";
  if (status === 408 || /timed? out|timeout|aborterror/i.test(message))
    return "TIMEOUT";
  if (
    status === 413 ||
    /context length|context window|too many tokens|max(?:imum)? tokens/i.test(
      message,
    )
  )
    return "CONTEXT_LIMIT";
  if (
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 529 ||
    /overload|unavailable/i.test(message)
  )
    return "UNAVAILABLE";
  if (/network|fetch failed|econn|enotfound|socket|dns/i.test(message))
    return "NETWORK";
  return "INTERNAL";
}

export function normalizeAIProviderFailure(
  error: unknown,
  fallbackProvider = "anthropic",
): AIProviderFailure {
  if (error instanceof AIProviderFailure) return error;
  if (error instanceof LLMProviderNotConfiguredError) {
    return new AIProviderFailure({
      provider: fallbackProvider,
      category: "AUTHENTICATION",
      retryable: false,
    });
  }
  const candidate = error as {
    provider?: string;
    status?: number;
    retryable?: boolean;
    message?: string;
    name?: string;
  };
  const message = candidate?.message ?? String(error);
  const category = classifyMessage(message, candidate?.status);
  const transient = [
    "RATE_LIMIT",
    "UNAVAILABLE",
    "TIMEOUT",
    "NETWORK",
  ].includes(category);
  return new AIProviderFailure({
    provider:
      error instanceof LLMProviderError
        ? error.provider
        : (candidate?.provider ?? fallbackProvider),
    category,
    status: candidate?.status,
    retryable: transient && candidate?.retryable !== false,
  });
}

export function isAIProviderFailure(
  error: unknown,
): error is AIProviderFailure {
  return error instanceof AIProviderFailure;
}

export function safeAIProviderMessage(
  category: AIProviderFailureCategory,
): string {
  return SAFE_MESSAGES[category];
}
