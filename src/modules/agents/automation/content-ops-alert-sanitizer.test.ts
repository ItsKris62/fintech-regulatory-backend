import { describe, it, expect } from 'vitest';
import { sanitizeAlertText, sanitizeAlertMetadata } from './content-ops-alert-sanitizer';

describe('sanitizeAlertText', () => {
  it('strips HTML tags', () => {
    expect(sanitizeAlertText('<b>bold</b> and <script>evil()</script>')).toBe('bold and evil()');
  });

  it('caps length', () => {
    const long = 'x'.repeat(3000);
    const result = sanitizeAlertText(long, 10);
    expect(result.length).toBe(11); // 10 chars + ellipsis
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('sanitizeAlertMetadata', () => {
  it('passes through ids, counts, scores, enum values, and booleans unchanged', () => {
    const { metadata, droppedKeys } = sanitizeAlertMetadata({
      suggestionId: 'sug_1',
      occurrenceCount: 3,
      confidence: 0.87,
      status: 'BLOCKED',
      urgent: true,
    });
    expect(metadata).toEqual({
      suggestionId: 'sug_1',
      occurrenceCount: 3,
      confidence: 0.87,
      status: 'BLOCKED',
      urgent: true,
    });
    expect(droppedKeys).toEqual([]);
  });

  it('drops forbidden keys by name regardless of value shape', () => {
    const { metadata, droppedKeys } = sanitizeAlertMetadata({
      apiToken: 'sb_agent_deadbeef',
      credentialSecret: 'x',
      renderedHtml: '<p>hi</p>',
      articleBody: 'full text',
      prompt: 'system prompt text',
      safeField: 'ok',
    });
    expect(metadata).toEqual({ safeField: 'ok' });
    expect(droppedKeys).toEqual(
      expect.arrayContaining(['apiToken', 'credentialSecret', 'renderedHtml', 'articleBody', 'prompt']),
    );
  });

  it('drops arrays and nested objects (only flat scalars allowed)', () => {
    const { metadata, droppedKeys } = sanitizeAlertMetadata({
      recipientList: ['a@example.com', 'b@example.com'],
      nested: { a: 1 },
      safeField: 'ok',
    });
    expect(metadata).toEqual({ safeField: 'ok' });
    expect(droppedKeys).toEqual(expect.arrayContaining(['recipientList', 'nested']));
  });

  it('strips HTML and truncates long string values', () => {
    const { metadata } = sanitizeAlertMetadata({ note: '<b>' + 'x'.repeat(600) + '</b>' });
    expect((metadata.note as string).length).toBeLessThanOrEqual(501);
    expect(metadata.note).not.toContain('<b>');
  });

  it('returns an empty object for undefined/null input', () => {
    expect(sanitizeAlertMetadata(undefined)).toEqual({ metadata: {}, droppedKeys: [] });
    expect(sanitizeAlertMetadata(null)).toEqual({ metadata: {}, droppedKeys: [] });
  });

  it('falls back to a minimal marker when the sanitized object is still oversized', () => {
    const huge: Record<string, string> = {};
    for (let i = 0; i < 50; i++) huge[`field${i}`] = 'y'.repeat(400);
    const { metadata } = sanitizeAlertMetadata(huge);
    expect(metadata.truncated).toBe(true);
    expect(typeof metadata.originalKeyCount).toBe('number');
  });
});
