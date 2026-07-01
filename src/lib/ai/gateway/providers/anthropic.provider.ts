import Anthropic from '@anthropic-ai/sdk';
import { appConfig } from '@/config/app.config';
import { ILLMProvider, LLMCompletionRequest, LLMCompletionResult, LLMStreamOptions, LLMProviderError, LLMProviderNotConfiguredError } from '../types';

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

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: req.prompt },
    ];

    try {
      const abortSignal = req.overrideTimeoutMs 
        ? (req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.overrideTimeoutMs)]) : AbortSignal.timeout(req.overrideTimeoutMs))
        : req.signal;

      const response = await client.messages.create(
        {
          model: req.model!,
          max_tokens: req.maxTokens!,
          temperature: req.temperature,
          system: req.systemPrompt,
          messages,
          stop_sequences: req.stopSequences,
          metadata: req.metadata,
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
        model: req.model!,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        stopReason: response.stop_reason,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw error;
      }
      const isRetryable = error.status ? [408, 429, 500, 502, 503, 504, 529].includes(error.status) : false;
      throw new LLMProviderError(this.name, error.message, error.status, isRetryable);
    }
  }

  async stream(opts: LLMStreamOptions): Promise<LLMCompletionResult> {
    const client = this.getClient();

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: opts.prompt },
    ];

    try {
      const abortSignal = opts.overrideTimeoutMs 
        ? (opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.overrideTimeoutMs)]) : AbortSignal.timeout(opts.overrideTimeoutMs))
        : opts.signal;

      const streamResponse = await client.messages.create(
        {
          model: opts.model!,
          max_tokens: opts.maxTokens!,
          temperature: opts.temperature,
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
        model: opts.model!,
        usage: {
          inputTokens,
          outputTokens,
        },
        stopReason,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw error;
      }
      const isRetryable = error.status ? [408, 429, 500, 502, 503, 504, 529].includes(error.status) : false;
      throw new LLMProviderError(this.name, error.message, error.status, isRetryable);
    }
  }
}
