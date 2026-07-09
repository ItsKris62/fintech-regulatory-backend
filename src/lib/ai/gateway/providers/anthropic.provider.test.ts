import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic.provider';

const createMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(function MockAnthropic() {
    return { messages: { create: createMock } };
  }),
}));

vi.mock('@/config/app.config', () => ({
  appConfig: {
    ai: { apiKey: 'sk-ant-test-key', model: 'claude-test' },
  },
}));

describe('AnthropicProvider metadata sanitization', () => {
  beforeEach(() => {
    createMock.mockReset();
  });
  it('does not forward internal SheriaBot metadata fields to Anthropic', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 2 },
      stop_reason: 'end_turn',
    });

    const provider = new AnthropicProvider();
    await provider.complete({
      model: 'claude-test',
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
      model: 'claude-test',
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
});
