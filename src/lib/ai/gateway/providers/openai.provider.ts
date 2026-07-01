import OpenAI from 'openai';
import { appConfig } from '@/config/app.config';
import { ILLMProvider, LLMCompletionRequest, LLMCompletionResult, LLMStreamOptions, LLMProviderError, LLMProviderNotConfiguredError } from '../types';

export class OpenAIProvider implements ILLMProvider {
  readonly name = 'openai';
  private client: OpenAI | null = null;
  private currentApiKey: string | null = null;

  private getClient(): OpenAI {
    const apiKey = appConfig.openai?.apiKey;
    if (!apiKey) {
      throw new LLMProviderNotConfiguredError(this.name);
    }
    if (this.currentApiKey !== apiKey || !this.client) {
      this.client = new OpenAI({ apiKey, maxRetries: 0 });
      this.currentApiKey = apiKey;
    }
    return this.client;
  }

  isConfigured(): boolean {
    return !!appConfig.openai?.apiKey;
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResult> {
    const client = this.getClient();

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (req.systemPrompt) {
      messages.push({ role: 'system', content: req.systemPrompt });
    }
    messages.push({ role: 'user', content: req.prompt });

    try {
      const abortSignal = req.overrideTimeoutMs 
        ? (req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.overrideTimeoutMs)]) : AbortSignal.timeout(req.overrideTimeoutMs))
        : req.signal;

      const response = await client.chat.completions.create(
        {
          model: req.model!,
          messages,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          stop: req.stopSequences,
        },
        { signal: abortSignal }
      );

      const choice = response.choices[0];
      
      return {
        content: choice?.message?.content || '',
        provider: this.name,
        model: req.model!,
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
        },
        stopReason: choice?.finish_reason || null,
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

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (opts.systemPrompt) {
      messages.push({ role: 'system', content: opts.systemPrompt });
    }
    messages.push({ role: 'user', content: opts.prompt });

    try {
      const abortSignal = opts.overrideTimeoutMs 
        ? (opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.overrideTimeoutMs)]) : AbortSignal.timeout(opts.overrideTimeoutMs))
        : opts.signal;

      const streamResponse = await client.chat.completions.create(
        {
          model: opts.model!,
          messages,
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
          stop: opts.stopSequences,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: abortSignal }
      );

      let fullContent = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: string | null = null;

      for await (const chunk of streamResponse) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          if (opts.onChunk) {
            opts.onChunk(delta);
          }
        }
        if (chunk.choices[0]?.finish_reason) {
          stopReason = chunk.choices[0].finish_reason;
        }
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens;
          outputTokens = chunk.usage.completion_tokens;
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
