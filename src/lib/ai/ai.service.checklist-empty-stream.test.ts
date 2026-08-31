import { beforeEach, describe, expect, it, vi } from 'vitest';

const { completeMock, streamMock } = vi.hoisted(() => ({
  completeMock: vi.fn(),
  streamMock: vi.fn(),
}));

vi.mock('./client', () => ({
  complete: completeMock,
  stream: streamMock,
}));

import { AIService } from './ai.service';

describe('AIService checklist empty-stream recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses one non-stream completion when Anthropic emits no text and zero output tokens', async () => {
    streamMock.mockResolvedValue({
      content: '',
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 0,
      cost: 0,
      stopReason: 'end_turn',
    });
    completeMock.mockResolvedValue({
      content: '{"metadata":{"productType":"DCP"},"categories":[]}',
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 20,
      cost: 0,
      stopReason: 'end_turn',
    });

    const result = await new AIService().executeChecklistStream({
      systemPrompt: 'Return JSON only.',
      userPrompt: 'Generate a checklist.',
      maxTokens: 1024,
      overrideTimeoutMs: 30_000,
    }, vi.fn());

    expect(completeMock).toHaveBeenCalledOnce();
    expect(result.content).toContain('"categories"');
    expect(result.outputTokens).toBe(20);
  });

  it('does not invoke the fallback for a non-empty stream', async () => {
    streamMock.mockResolvedValue({
      content: '{"metadata":{},"categories":[]}',
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 15,
      cost: 0,
      stopReason: 'end_turn',
    });

    await new AIService().executeChecklistStream({
      systemPrompt: 'Return JSON only.',
      userPrompt: 'Generate a checklist.',
      maxTokens: 1024,
      overrideTimeoutMs: 30_000,
    }, vi.fn());

    expect(completeMock).not.toHaveBeenCalled();
  });
});
