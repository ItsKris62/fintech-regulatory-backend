import { describe, it, expect, vi } from 'vitest';
import { resolveVerificationEvidence, FALLBACK_CONFIDENCE_PENALTY } from './verification-evidence';

const NOW = new Date('2026-07-28T00:00:00.000Z');

function makePost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post_1',
    content: 'Some content',
    sources: [],
    ...overrides,
  } as never;
}

function makePostSource(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ps_1',
    title: 'A source',
    url: 'https://example.com/a',
    notes: 'Some notes',
    updatedAt: NOW,
    ...overrides,
  };
}

describe('resolveVerificationEvidence', () => {
  it('prefers an active research pack over BlogPostSource rows', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'pack_1',
      sourceSetHash: 'hash_abc',
      obligationsSummary: [{ statement: 'Must obtain a license.', category: 'LICENSING_REQUIREMENT' }],
      authorities: [{ name: 'CBK', role: 'Regulator' }],
      importantDates: [{ label: 'Deadline', date: '2026-09-01' }],
    });
    const prisma = { blogResearchPack: { findFirst } };
    const post = makePost({ sources: [makePostSource()] });

    const evidence = await resolveVerificationEvidence(prisma, post);
    expect(evidence.mode).toBe('research_pack');
    expect(evidence.researchPackId).toBe('pack_1');
    expect(evidence.sourceSetHash).toBe('hash_abc');
    expect(evidence.confidencePenalty).toBe(0);
    expect(evidence.items).toHaveLength(3);
  });

  it('falls back to BlogPostSource rows when no active research pack exists, with a confidence penalty', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { blogResearchPack: { findFirst } };
    const post = makePost({ sources: [makePostSource()] });

    const evidence = await resolveVerificationEvidence(prisma, post);
    expect(evidence.mode).toBe('fallback_post_sources');
    expect(evidence.confidencePenalty).toBe(FALLBACK_CONFIDENCE_PENALTY);
    expect(evidence.items).toHaveLength(1);
    expect(evidence.items[0].sourceId).toBe('ps_1');
  });

  it('returns no_evidence mode when there is no research pack and no BlogPostSource rows', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { blogResearchPack: { findFirst } };
    const post = makePost({ sources: [] });

    const evidence = await resolveVerificationEvidence(prisma, post);
    expect(evidence.mode).toBe('no_evidence');
    expect(evidence.items).toHaveLength(0);
  });

  it('reuses the research pack sourceSetHash directly rather than recomputing it', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'pack_1',
      sourceSetHash: 'exact-reused-hash',
      obligationsSummary: [],
      authorities: [],
      importantDates: [],
    });
    const prisma = { blogResearchPack: { findFirst } };
    const post = makePost();

    const evidence = await resolveVerificationEvidence(prisma, post);
    expect(evidence.sourceSetHash).toBe('exact-reused-hash');
  });

  it('assigns stable, unique sourceRefs to each evidence item in research_pack mode', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'pack_1',
      sourceSetHash: 'h',
      obligationsSummary: [{ statement: 'A', category: 'LEGAL_OBLIGATION' }, { statement: 'B', category: 'DEADLINE' }],
      authorities: [],
      importantDates: [],
    });
    const prisma = { blogResearchPack: { findFirst } };
    const post = makePost();

    const evidence = await resolveVerificationEvidence(prisma, post);
    const refs = evidence.items.map((i) => i.sourceRef);
    expect(new Set(refs).size).toBe(refs.length);
  });
});
