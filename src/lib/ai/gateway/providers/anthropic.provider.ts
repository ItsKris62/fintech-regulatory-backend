import Anthropic from '@anthropic-ai/sdk';
import { appConfig } from '@/config/app.config';
import { logger } from '@/utils/logger';
import { ILLMProvider, LLMCompletionRequest, LLMCompletionResult, LLMStreamOptions, LLMProviderError, LLMProviderNotConfiguredError } from '../types';

function sanitizeAnthropicMetadata(metadata: LLMCompletionRequest['metadata']): Anthropic.Messages.Metadata | undefined {
  if (!metadata) return undefined;
  const userId = metadata.user_id;
  if (typeof userId !== 'string' || userId.trim().length === 0) return undefined;
  return { user_id: userId };
}

function assertUsableAnthropicModel(model: string | undefined): string {
  const normalized = model?.trim().replace(/^anthropic:/, '');
  if (!normalized) {
    logger.error({ type: 'anthropic_model_config_invalid', reason: 'missing_model' });
    throw new LLMProviderError('anthropic', 'Anthropic model is not configured.', 400, false);
  }

  if (!/^claude-[a-z0-9][a-z0-9-]*(?:-\d{8})?$/.test(normalized)) {
    logger.error({ type: 'anthropic_model_config_invalid', reason: 'invalid_model_id_shape', model: normalized });
    throw new LLMProviderError('anthropic', 'Anthropic model is invalid.', 400, false);
  }

  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseAnthropicErrorBody(message: string): Record<string, unknown> | null {
  const jsonStart = message.indexOf('{');
  if (jsonStart < 0) return null;
  try {
    return asRecord(JSON.parse(message.slice(jsonStart)));
  } catch {
    return null;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getHeaderValue(headers: unknown, name: string): string | undefined {
  const getter = asRecord(headers)?.get;
  if (typeof getter === 'function') {
    const value = getter.call(headers, name);
    return readString(value);
  }

  const record = asRecord(headers);
  return readString(record?.[name]) ?? readString(record?.[name.toLowerCase()]);
}

function getAnthropicErrorDetails(error: unknown): {
  status?: number;
  providerErrorType?: string;
  providerMessage?: string;
  providerRequestId?: string;
} {
  const record = asRecord(error);
  const message = error instanceof Error ? error.message : String(error);
  const body = asRecord(record?.error) ?? parseAnthropicErrorBody(message);
  const nestedError = asRecord(body?.error);

  return {
    status: typeof record?.status === 'number' ? record.status : undefined,
    providerErrorType: readString(nestedError?.type) ?? readString(body?.type),
    providerMessage: readString(nestedError?.message) ?? readString(record?.message) ?? message,
    providerRequestId: readString(record?.request_id)
      ?? readString(record?.requestId)
      ?? readString(body?.request_id)
      ?? getHeaderValue(record?.headers, 'request-id')
      ?? getHeaderValue(record?.headers, 'x-request-id'),
  };
}

function logAnthropicProviderError(error: unknown, model: string | undefined, operation: 'complete' | 'stream'): void {
  const details = getAnthropicErrorDetails(error);
  logger.error({
    type: 'anthropic_provider_error',
    operation,
    status: details.status,
    providerErrorType: details.providerErrorType,
    providerMessage: details.providerMessage,
    providerRequestId: details.providerRequestId,
    model,
  });
}

export class AnthropicProvider implements ILLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic | null = null;
  private currentApiKey: string | null = null;

  private getClient(): Anthropic {
    const apiKey = appConfig.ai.apiKey;
    if (!apiKey) {
      throw new LLMProviderNotConfiguredError(this.name);
    }
    if (this.currentApiKey !== apiKey || !this.client) {
      this.client = new Anthropic({ apiKey, maxRetries: 0 });
      this.currentApiKey = apiKey;
    }
    return this.client;
  }

  isConfigured(): boolean {
    return !!appConfig.ai.apiKey;
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResult> {
    const client = this.getClient();
    const model = assertUsableAnthropicModel(req.model);

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: req.prompt },
    ];

    try {
      const abortSignal = req.overrideTimeoutMs 
        ? (req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.overrideTimeoutMs)]) : AbortSignal.timeout(req.overrideTimeoutMs))
        : req.signal;

      const metadata = sanitizeAnthropicMetadata(req.metadata);
      const noTemp = model.includes('sonnet-5') || model.includes('opus-5') || model.includes('fable-5');
      const response = await client.messages.create(
        {
          model,
          max_tokens: req.maxTokens!,
          ...(noTemp ? {} : { temperature: req.temperature }),
          system: req.systemPrompt,
          messages,
          stop_sequences: req.stopSequences,
          ...(metadata ? { metadata } : {}),
        },
        { signal: abortSignal }
      );

      const content = response.content
        .filter(block => block.type === 'text')
        .map(block => (block as Anthropic.TextBlock).text)
        .join('\n');

      return {
        content,
        provider: this.name,
        model,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        stopReason: response.stop_reason,
      };
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      logAnthropicProviderError(error, model, 'complete');
      const details = getAnthropicErrorDetails(error);
      const isRetryable = details.status ? [408, 429, 500, 502, 503, 504, 529].includes(details.status) : false;
      const message = error instanceof Error ? error.message : String(error);
      throw new LLMProviderError(this.name, message, details.status, isRetryable);
    }
  }

  async stream(opts: LLMStreamOptions): Promise<LLMCompletionResult> {
    const client = this.getClient();
    const model = assertUsableAnthropicModel(opts.model);

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: opts.prompt },
    ];

    try {
      const abortSignal = opts.overrideTimeoutMs 
        ? (opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.overrideTimeoutMs)]) : AbortSignal.timeout(opts.overrideTimeoutMs))
        : opts.signal;

      const noTemp = model.includes('sonnet-5') || model.includes('opus-5') || model.includes('fable-5');
      const streamResponse = await client.messages.create(
        {
          model,
          max_tokens: opts.maxTokens!,
          ...(noTemp ? {} : { temperature: opts.temperature }),
          system: opts.systemPrompt,
          messages,
          stop_sequences: opts.stopSequences,
          stream: true,
        },
        { signal: abortSignal }
      );

      let fullContent = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: string | null = null;

      for await (const event of streamResponse) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            const chunk = event.delta.text;
            fullContent += chunk;
            if (opts.onChunk) {
              opts.onChunk(chunk);
            }
          }
        } else if (event.type === 'message_start') {
          inputTokens = event.message.usage.input_tokens;
        } else if (event.type === 'message_delta') {
          outputTokens = event.usage.output_tokens;
          if (event.delta.stop_reason) {
            stopReason = event.delta.stop_reason;
          }
        }
      }

      return {
        content: fullContent,
        provider: this.name,
        model,
        usage: {
          inputTokens,
          outputTokens,
        },
        stopReason,
      };
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      logAnthropicProviderError(error, model, 'stream');
      const details = getAnthropicErrorDetails(error);
      const isRetryable = details.status ? [408, 429, 500, 502, 503, 504, 529].includes(details.status) : false;
      const message = error instanceof Error ? error.message : String(error);
      throw new LLMProviderError(this.name, message, details.status, isRetryable);
    }
  }
}
