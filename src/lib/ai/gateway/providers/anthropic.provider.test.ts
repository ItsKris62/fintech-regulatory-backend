import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/utils/logger';
import { AnthropicProvider } from './anthropic.provider';

const createMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(function MockAnthropic() {
    return { messages: { create: createMock } };
  }),
}));

vi.mock('@/config/app.config', () => ({
  appConfig: {
    ai: { apiKey: 'sk-ant-test-key', model: 'claude-haiku-4-5-20251001' },
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    error: vi.fn(),
  },
}));

describe('AnthropicProvider metadata sanitization', () => {
  beforeEach(() => {
    createMock.mockReset();
    vi.mocked(logger.error).mockClear();
  });

  it('does not forward internal SheriaBot metadata fields to Anthropic', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 2 },
      stop_reason: 'end_turn',
    });

    const provider = new AnthropicProvider();
    await provider.complete({
      model: 'claude-haiku-4-5-20251001',
      prompt: 'hello',
      maxTokens: 100,
      metadata: {
        agent: 'automation-generation',
        workflowKey: 'W-CONTENT-02',
        taskType: 'regulatory_content_draft',
        runId: 'run-1',
        department: 'marketing',
      },
    });

    const request = createMock.mock.calls[0][0];
    expect(request).toEqual(expect.objectContaining({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
    }));
    expect(request).not.toHaveProperty('metadata.agent');
    expect(request).not.toHaveProperty('metadata.workflowKey');
    expect(request).not.toHaveProperty('metadata.taskType');
    expect(request).not.toHaveProperty('metadata.runId');
    expect(request).not.toHaveProperty('metadata.department');
    expect(request.metadata).toBeUndefined();
  });

  it('only forwards Anthropic-supported user_id metadata', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 2 },
      stop_reason: 'end_turn',
    });

    const provider = new AnthropicProvider();
    await provider.complete({
      model: 'claude-haiku-4-5-20251001',
      prompt: 'hello',
      maxTokens: 100,
      metadata: {
        user_id: 'user-123',
        agent: 'automation-generation',
      },
    });

    const request = createMock.mock.calls[0][0];
    expect(request.metadata).toEqual({ user_id: 'user-123' });
  });

  it('logs safe Anthropic 400 details without prompt or internal metadata', async () => {
    const error = new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"metadata.agent: Extra inputs are not permitted"},"request_id":"req_safe_123"}');
    Object.assign(error, { status: 400 });
    createMock.mockRejectedValueOnce(error);

    const provider = new AnthropicProvider();
    await expect(provider.complete({
      model: 'claude-haiku-4-5-20251001',
      prompt: 'secret prompt body',
      maxTokens: 100,
      metadata: { agent: 'automation', workflowKey: 'W-CONTENT-02' },
    })).rejects.toThrow('metadata.agent');

    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      type: 'anthropic_provider_error',
      operation: 'complete',
      status: 400,
      providerErrorType: 'invalid_request_error',
      providerMessage: 'metadata.agent: Extra inputs are not permitted',
      providerRequestId: 'req_safe_123',
      model: 'claude-haiku-4-5-20251001',
    }));
    const loggedPayload = vi.mocked(logger.error).mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(loggedPayload)).not.toContain('secret prompt body');
    expect(JSON.stringify(loggedPayload)).not.toContain('W-CONTENT-02');
  });
});
