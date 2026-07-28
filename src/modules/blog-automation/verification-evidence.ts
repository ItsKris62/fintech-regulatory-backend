import type { BlogPost, BlogPostSource } from '@prisma/client';
import { computeFallbackSourceSetHash } from './editorial-input-hash';

/**
 * Resolves the evidence semantic verification compares article claims
 * against. Preferred evidence is the post's active BlogResearchPack (its
 * already-synthesized findings - never re-fetched raw source bodies).
 * Falls back to the post's own BlogPostSource rows when no active research
 * pack exists, with an explicit confidence penalty, since raw source titles
 * are weaker evidence than a synthesized, source-graded research pack.
 */

export interface EvidenceItem {
  sourceRef: string;
  /** BlogPostSource.id in fallback mode; undefined in research_pack mode (the pack's sources are not individually re-cited here). */
  sourceId?: string;
  sourceUrl?: string | null;
  title?: string;
  text: string;
  category?: string;
}

export type VerificationEvidenceMode = 'research_pack' | 'fallback_post_sources' | 'no_evidence';

export interface VerificationEvidence {
  mode: VerificationEvidenceMode;
  researchPackId?: string;
  /** Reused directly from the active research pack when in research_pack mode - never recomputed. */
  sourceSetHash: string;
  items: EvidenceItem[];
  /** Added to LOW_STRUCTURED_AI_CONFIDENCE-style checks when evidence is weaker than a research pack. */
  confidencePenalty: number;
}

export const FALLBACK_CONFIDENCE_PENALTY = 20;

interface ResearchPackLike {
  id: string;
  sourceSetHash: string;
  obligationsSummary: unknown;
  authorities: unknown;
  importantDates: unknown;
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null);
}

function fieldToString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function evidenceFromResearchPack(pack: ResearchPackLike): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  let ref = 1;

  for (const o of asArray(pack.obligationsSummary)) {
    const statement = fieldToString(o.statement);
    if (!statement) continue;
    items.push({ sourceRef: `E${ref++}`, text: statement, category: fieldToString(o.category) });
  }
  for (const a of asArray(pack.authorities)) {
    const name = fieldToString(a.name);
    if (!name) continue;
    const role = fieldToString(a.role);
    items.push({ sourceRef: `E${ref++}`, text: role ? `${name} (${role})` : name });
  }
  for (const d of asArray(pack.importantDates)) {
    const label = fieldToString(d.label);
    if (!label) continue;
    const date = fieldToString(d.date);
    items.push({ sourceRef: `E${ref++}`, text: date ? `${label} - ${date}` : label });
  }

  return items;
}

function evidenceFromPostSources(sources: readonly BlogPostSource[]): EvidenceItem[] {
  return sources.map((s, index) => ({
    sourceRef: `E${index + 1}`,
    sourceId: s.id,
    sourceUrl: s.url,
    title: s.title,
    text: s.notes ?? s.title,
  }));
}

export interface VerificationEvidencePrisma {
  blogResearchPack: {
    findFirst(args: object): Promise<ResearchPackLike | null>;
  };
}

export async function resolveVerificationEvidence(
  prisma: VerificationEvidencePrisma,
  post: BlogPost & { sources: BlogPostSource[] },
): Promise<VerificationEvidence> {
  const activePack = await prisma.blogResearchPack.findFirst({
    where: { blogPostId: post.id, status: 'COMPLETE' },
    orderBy: { version: 'desc' },
  });

  if (activePack) {
    return {
      mode: 'research_pack',
      researchPackId: activePack.id,
      sourceSetHash: activePack.sourceSetHash,
      items: evidenceFromResearchPack(activePack),
      confidencePenalty: 0,
    };
  }

  if (post.sources.length === 0) {
    return { mode: 'no_evidence', sourceSetHash: '', items: [], confidencePenalty: FALLBACK_CONFIDENCE_PENALTY };
  }

  return {
    mode: 'fallback_post_sources',
    sourceSetHash: computeFallbackSourceSetHash(post.sources.map((s) => ({ url: s.url, updatedAt: s.updatedAt }))),
    items: evidenceFromPostSources(post.sources),
    confidencePenalty: FALLBACK_CONFIDENCE_PENALTY,
  };
}

