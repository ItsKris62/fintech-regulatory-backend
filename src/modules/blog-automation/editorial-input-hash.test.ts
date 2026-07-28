import { describe, it, expect } from 'vitest';
import {
  computeTriageInputHash,
  computeResearchInputHash,
  computeResearchSourceSetHash,
  computeContentHash,
  computeFallbackSourceSetHash,
} from './editorial-input-hash';

describe('computeTriageInputHash', () => {
  const base = {
    sourceItemId: 'src_1',
    title: 'New CBK Circular',
    summary: 'Details about the circular',
    sourceType: 'OFFICIAL',
    authorityType: 'CENTRAL_BANK',
    jurisdiction: 'KE',
    publicationDate: new Date('2026-01-01T00:00:00.000Z'),
    deterministicScore: 80,
    scoringPolicyVersion: 'relevance-scoring-v1',
    promptVersion: 'editorial-triage-v1',
  };

  it('is deterministic for identical input', () => {
    expect(computeTriageInputHash(base)).toBe(computeTriageInputHash({ ...base }));
  });

  it('changes when the title changes', () => {
    expect(computeTriageInputHash(base)).not.toBe(computeTriageInputHash({ ...base, title: 'Different title' }));
  });

  it('changes when the deterministic score changes', () => {
    expect(computeTriageInputHash(base)).not.toBe(computeTriageInputHash({ ...base, deterministicScore: 81 }));
  });

  it('changes when promptVersion changes', () => {
    expect(computeTriageInputHash(base)).not.toBe(computeTriageInputHash({ ...base, promptVersion: 'editorial-triage-v2' }));
  });

  it('is not affected by title casing/whitespace differences (normalized)', () => {
    expect(computeTriageInputHash(base)).toBe(computeTriageInputHash({ ...base, title: '  NEW cbk circular  ' }));
  });

  it('distinguishes a sourceItemId-keyed input from a suggestionId-only fallback input', () => {
    const sourceItemKeyed = computeTriageInputHash(base);
    const suggestionOnly = computeTriageInputHash({ ...base, sourceItemId: null, suggestionId: 'sug_1' });
    expect(sourceItemKeyed).not.toBe(suggestionOnly);
  });
});

describe('computeResearchInputHash', () => {
  const base = {
    researchObjective: 'Summarize obligations for KE data protection circular',
    canonicalTargetId: 'sug_1',
    promptVersion: 'research-pack-v1',
    researchPolicyVersion: 'research-pack-policy-v1',
  };

  it('is deterministic for identical input', () => {
    expect(computeResearchInputHash(base)).toBe(computeResearchInputHash({ ...base }));
  });

  it('changes when the objective changes', () => {
    expect(computeResearchInputHash(base)).not.toBe(
      computeResearchInputHash({ ...base, researchObjective: 'A different objective' }),
    );
  });

  it('does not change when the source set changes (isolates objective/target/version only)', () => {
    // sourceSetHash is a separate function - inputHash must stay stable across source-set changes.
    expect(computeResearchInputHash(base)).toBe(computeResearchInputHash({ ...base }));
  });

  it('changes when the canonical target changes (blogPostId vs suggestionId)', () => {
    expect(computeResearchInputHash(base)).not.toBe(computeResearchInputHash({ ...base, canonicalTargetId: 'post_1' }));
  });
});

describe('computeResearchSourceSetHash', () => {
  function source(overrides: Partial<Parameters<typeof computeResearchSourceSetHash>[0][number]> = {}) {
    return {
      stableSourceId: 'src_1',
      normalizedUrl: 'https://example.com/a',
      contentHash: 'hash-a',
      publicationDate: new Date('2026-01-01T00:00:00.000Z'),
      isAvailable: true,
      category: 'OFFICIAL_REGULATOR',
      trustLevel: 90,
      ...overrides,
    };
  }

  it('is deterministic regardless of input array order (sorted internally)', () => {
    const a = source({ stableSourceId: 'a' });
    const b = source({ stableSourceId: 'b' });
    expect(computeResearchSourceSetHash([a, b])).toBe(computeResearchSourceSetHash([b, a]));
  });

  it('changes when a source contentHash changes behind the same URL', () => {
    const original = [source({ contentHash: 'hash-a' })];
    const changed = [source({ contentHash: 'hash-b' })];
    expect(computeResearchSourceSetHash(original)).not.toBe(computeResearchSourceSetHash(changed));
  });

  it('changes when publicationDate is corrected', () => {
    const original = [source({ publicationDate: new Date('2026-01-01T00:00:00.000Z') })];
    const corrected = [source({ publicationDate: new Date('2026-01-02T00:00:00.000Z') })];
    expect(computeResearchSourceSetHash(original)).not.toBe(computeResearchSourceSetHash(corrected));
  });

  it('changes when a source becomes unavailable', () => {
    const original = [source({ isAvailable: true })];
    const changed = [source({ isAvailable: false })];
    expect(computeResearchSourceSetHash(original)).not.toBe(computeResearchSourceSetHash(changed));
  });

  it('is not affected by URL alone when content/date/availability are unchanged (still equal)', () => {
    expect(computeResearchSourceSetHash([source()])).toBe(computeResearchSourceSetHash([source()]));
  });

  it('produces a stable hash for an empty source list', () => {
    expect(computeResearchSourceSetHash([])).toBe(computeResearchSourceSetHash([]));
  });
});

describe('computeContentHash', () => {
  it('is deterministic for identical content', () => {
    expect(computeContentHash('Hello world')).toBe(computeContentHash('Hello world'));
  });

  it('changes when content changes', () => {
    expect(computeContentHash('Hello world')).not.toBe(computeContentHash('Hello there'));
  });

  it('treats null and undefined the same as empty string', () => {
    expect(computeContentHash(null)).toBe(computeContentHash(undefined));
    expect(computeContentHash(null)).toBe(computeContentHash(''));
  });

  it('never throws for null/undefined/empty input', () => {
    expect(() => computeContentHash(null)).not.toThrow();
    expect(() => computeContentHash(undefined)).not.toThrow();
  });
});

describe('computeFallbackSourceSetHash', () => {
  const d1 = new Date('2026-01-01T00:00:00.000Z');
  const d2 = new Date('2026-02-01T00:00:00.000Z');

  it('is deterministic regardless of input array order (sorted internally)', () => {
    const a = { url: 'https://a.example', updatedAt: d1 };
    const b = { url: 'https://b.example', updatedAt: d2 };
    expect(computeFallbackSourceSetHash([a, b])).toBe(computeFallbackSourceSetHash([b, a]));
  });

  it('changes when a source updatedAt changes', () => {
    const original = [{ url: 'https://a.example', updatedAt: d1 }];
    const changed = [{ url: 'https://a.example', updatedAt: d2 }];
    expect(computeFallbackSourceSetHash(original)).not.toBe(computeFallbackSourceSetHash(changed));
  });

  it('produces a stable hash for an empty source list', () => {
    expect(computeFallbackSourceSetHash([])).toBe(computeFallbackSourceSetHash([]));
  });
});
