export type LLMProviderName = 'anthropic' | 'openai' | 'gemini';

export interface LLMCompletionRequest {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  metadata?: Record<string, any>;
  overrideTimeoutMs?: number;
  provider?: LLMProviderName;
  useCase?: 'policy' | 'checklist' | 'query' | 'verification' | 'analysis' | 'default';
  allowFallback?: boolean;
  signal?: AbortSignal;
}

export interface LLMCompletionResult {
  content: string;
  provider: LLMProviderName;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  stopReason: string | null;
  cached?: boolean;
}

export interface LLMStreamOptions extends LLMCompletionRequest {
  onChunk?: (chunk: string) => void;
  onComplete?: (result: LLMCompletionResult) => void;
  onError?: (error: Error) => void;
  externalAbortSignal?: AbortSignal;
}

export interface ILLMProvider {
  readonly name: LLMProviderName;
  isConfigured(): boolean;
  complete(req: LLMCompletionRequest): Promise<LLMCompletionResult>;
  stream(opts: LLMStreamOptions): Promise<LLMCompletionResult>;
}

export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class LLMProviderError extends LLMError {
  public provider: string;
  public status?: number;
  public retryable: boolean;

  constructor(provider: string, message: string, status?: number, retryable: boolean = false) {
    super(`[${provider}] ${message}`);
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
  }
}

export class LLMProviderNotConfiguredError extends LLMError {
  constructor(provider: string) {
    super(`LLM Provider '${provider}' is not configured (missing API key).`);
  }
}

export class LLMCostLimitError extends LLMError {
  constructor(message: string) {
    super(message);
  }
}
