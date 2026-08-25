import { GoogleGenAI } from '@google/genai';
import { appConfig } from '@/config/app.config';
import { ILLMProvider, LLMCompletionRequest, LLMCompletionResult, LLMStreamOptions, LLMProviderError, LLMProviderNotConfiguredError } from '../types';

export class GeminiProvider implements ILLMProvider {
  readonly name = 'gemini';
  private client: GoogleGenAI | null = null;
  private currentApiKey: string | null = null;

  private getClient(): GoogleGenAI {
    const apiKey = appConfig.gemini?.apiKey;
    if (!apiKey) {
      throw new LLMProviderNotConfiguredError(this.name);
    }
    if (this.currentApiKey !== apiKey || !this.client) {
      this.client = new GoogleGenAI({ apiKey });
      this.currentApiKey = apiKey;
    }
    return this.client;
  }

  isConfigured(): boolean {
    return !!appConfig.gemini?.apiKey;
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResult> {
    const client = this.getClient();

    try {
      const abortSignal = req.overrideTimeoutMs 
        ? (req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.overrideTimeoutMs)]) : AbortSignal.timeout(req.overrideTimeoutMs))
        : req.signal;

      const actualModel = req.model?.replace(/^gemini:/, '') || 'gemini-3.5-flash';

      const promise = client.models.generateContent({
        model: actualModel,
        contents: req.prompt,
        config: {
          systemInstruction: req.systemPrompt,
          maxOutputTokens: req.maxTokens,
          temperature: req.temperature,
          stopSequences: req.stopSequences,
        }
      });

      const response = await Promise.race([
        promise,
        new Promise<any>((_, reject) => {
          if (abortSignal) {
            if (abortSignal.aborted) return reject(new Error('AbortError'));
            abortSignal.addEventListener('abort', () => reject(new Error('AbortError')));
          }
        })
      ]);

      return {
        content: response.text || '',
        provider: this.name,
        model: req.model!,
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount || 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
        },
        stopReason: response.candidates?.[0]?.finishReason || null,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw error;
      }
      const isRetryable = error.status ? [429, 500, 502, 503, 504].includes(error.status) : false;
      throw new LLMProviderError(this.name, error.message, error.status, isRetryable);
    }
  }

  async stream(opts: LLMStreamOptions): Promise<LLMCompletionResult> {
    const client = this.getClient();

    try {
      const abortSignal = opts.overrideTimeoutMs 
        ? (opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.overrideTimeoutMs)]) : AbortSignal.timeout(opts.overrideTimeoutMs))
        : opts.signal;

      const actualModel = opts.model?.replace(/^gemini:/, '') || 'gemini-3.5-flash';

      const promise = client.models.generateContentStream({
        model: actualModel,
        contents: opts.prompt,
        config: {
          systemInstruction: opts.systemPrompt,
          maxOutputTokens: opts.maxTokens,
          temperature: opts.temperature,
          stopSequences: opts.stopSequences,
        }
      });

      const streamResponse = await Promise.race([
        promise,
        new Promise<any>((_, reject) => {
          if (abortSignal) {
            if (abortSignal.aborted) return reject(new Error('AbortError'));
            abortSignal.addEventListener('abort', () => reject(new Error('AbortError')));
          }
        })
      ]);

      let fullContent = '';
      let lastResponse: any = null;

      for await (const chunk of streamResponse) {
        lastResponse = chunk;
        const delta = chunk.text;
        if (delta) {
          fullContent += delta;
          if (opts.onChunk) {
            opts.onChunk(delta);
          }
        }
      }

      return {
        content: fullContent,
        provider: this.name,
        model: opts.model!,
        usage: {
          inputTokens: lastResponse?.usageMetadata?.promptTokenCount || 0,
          outputTokens: lastResponse?.usageMetadata?.candidatesTokenCount || 0,
        },
        stopReason: lastResponse?.candidates?.[0]?.finishReason || null,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw error;
      }
      const isRetryable = error.status ? [429, 500, 502, 503, 504].includes(error.status) : false;
      throw new LLMProviderError(this.name, error.message, error.status, isRetryable);
    }
  }
}
