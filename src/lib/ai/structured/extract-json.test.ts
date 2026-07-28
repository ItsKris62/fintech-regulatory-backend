import { describe, it, expect } from 'vitest';
import { extractJsonCandidate, MAX_STRUCTURED_RESPONSE_LENGTH } from './extract-json';

describe('extractJsonCandidate', () => {
  it('extracts JSON from a fenced ```json code block', () => {
    const raw = '```json\n{"foo": "bar"}\n```';
    expect(extractJsonCandidate(raw)).toBe('{"foo": "bar"}');
  });

  it('extracts JSON from a fenced code block with no language tag', () => {
    const raw = '```\n{"foo": "bar"}\n```';
    expect(extractJsonCandidate(raw)).toBe('{"foo": "bar"}');
  });

  it('extracts unfenced raw JSON as-is', () => {
    const raw = '{"foo": "bar"}';
    expect(extractJsonCandidate(raw)).toBe('{"foo": "bar"}');
  });

  it('extracts JSON wrapped in prose', () => {
    const raw = 'Here is the JSON: {"foo": "bar"} Let me know if you need anything else.';
    expect(extractJsonCandidate(raw)).toBe('{"foo": "bar"}');
  });

  it('returns null when no JSON object is present', () => {
    const raw = 'I cannot help with that request.';
    expect(extractJsonCandidate(raw)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractJsonCandidate('')).toBeNull();
  });

  it('exposes the configured max length constant', () => {
    expect(MAX_STRUCTURED_RESPONSE_LENGTH).toBe(200_000);
  });
});
