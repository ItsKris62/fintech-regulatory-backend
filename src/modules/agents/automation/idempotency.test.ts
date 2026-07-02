import { describe, expect, it } from 'vitest';
import { deriveGenerateIdempotencyKey, type GenerateIdempotencyInput } from './idempotency';

function baseInput(overrides: Partial<GenerateIdempotencyInput> = {}): GenerateIdempotencyInput {
  return {
    workflowKey: 'W-CONTENT-02',
    taskType: 'regulatory_content_draft',
    systemPrompt: 'You are a compliance copywriter.',
    userPrompt: 'Draft a summary of the new CBK guideline.',
    maxTokens: 2000,
    ...overrides,
  };
}

describe('deriveGenerateIdempotencyKey', () => {
  it('is deterministic for identical input', () => {
    const a = deriveGenerateIdempotencyKey(baseInput());
    const b = deriveGenerateIdempotencyKey(baseInput());
    expect(a).toBe(b);
  });

  it('produces a 64-char lowercase hex sha256 digest', () => {
    const key = deriveGenerateIdempotencyKey(baseInput());
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when workflowKey changes', () => {
    const a = deriveGenerateIdempotencyKey(baseInput());
    const b = deriveGenerateIdempotencyKey(baseInput({ workflowKey: 'W-CONTENT-03' }));
    expect(a).not.toBe(b);
  });

  it('changes when taskType changes', () => {
    const a = deriveGenerateIdempotencyKey(baseInput());
    const b = deriveGenerateIdempotencyKey(baseInput({ taskType: 'marketing_blurb' }));
    expect(a).not.toBe(b);
  });

  it('changes when systemPrompt changes', () => {
    const a = deriveGenerateIdempotencyKey(baseInput());
    const b = deriveGenerateIdempotencyKey(baseInput({ systemPrompt: 'Different system prompt.' }));
    expect(a).not.toBe(b);
  });

  it('changes when userPrompt changes', () => {
    const a = deriveGenerateIdempotencyKey(baseInput());
    const b = deriveGenerateIdempotencyKey(baseInput({ userPrompt: 'Different user prompt.' }));
    expect(a).not.toBe(b);
  });

  it('changes when maxTokens changes', () => {
    const a = deriveGenerateIdempotencyKey(baseInput());
    const b = deriveGenerateIdempotencyKey(baseInput({ maxTokens: 3000 }));
    expect(a).not.toBe(b);
  });

  it('does not collide when a field boundary shifts (concatenation-collision guard)', () => {
    // workflowKey "a" + taskType "bc"  vs  workflowKey "ab" + taskType "c"
    const a = deriveGenerateIdempotencyKey(baseInput({ workflowKey: 'a', taskType: 'bc' }));
    const b = deriveGenerateIdempotencyKey(baseInput({ workflowKey: 'ab', taskType: 'c' }));
    expect(a).not.toBe(b);
  });
});
