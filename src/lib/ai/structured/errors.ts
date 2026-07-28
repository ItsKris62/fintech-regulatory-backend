import type { AIStructuredOutputErrorCode } from './types';

export class AIStructuredOutputError extends Error {
  constructor(
    public readonly code: AIStructuredOutputErrorCode,
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AIStructuredOutputError';
  }
}
