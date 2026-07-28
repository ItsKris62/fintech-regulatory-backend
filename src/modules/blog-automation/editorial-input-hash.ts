import { createHash } from 'node:crypto';

/**
 * Deterministic hashing for Stage C6 (triage), Stage C7 (research pack), and
 * Phase D (semantic verification / freshness) idempotency/versioning
 * decisions. Every hash here is a plain sha256 of an explicit, ordered,
 * delimited string built only from fields the caller passes in - never from
 * an execution/workflow ID, which per phase-b-data-model.md §1/§2/§3 must
 * never be a versioning signal on its own.
 */

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface TriageInputHashFields {
  /** Canonical BlogSourceItem id when resolvable - the common case. */
  sourceItemId?: string | null;
  /** Populated when resolution fell back to the suggestion-only path (no resolvable source item). */
  suggestionId?: string | null;
  title: string;
  summary?: string | null;
  sourceType: string;
  authorityType: string;
  /** Plain string - RegulatorySignal-derived candidates carry jurisdiction as free text, not the typed enum. */
  jurisdiction: string;
  publicationDate?: Date | null;
  deterministicScore: number;
  scoringPolicyVersion: string;
  promptVersion: string;
}

/** Bump when the deterministic scoring policy (weights/thresholds) changes materially. */
export const SCORING_POLICY_VERSION = 'relevance-scoring-v1';

export function computeTriageInputHash(input: TriageInputHashFields): string {
  const canonical = [
    `sourceItemId:${input.sourceItemId ?? ''}`,
    `suggestionId:${input.suggestionId ?? ''}`,
    `title:${input.title.trim().toLowerCase()}`,
    `summary:${(input.summary ?? '').trim().toLowerCase()}`,
    `sourceType:${input.sourceType}`,
    `authorityType:${input.authorityType}`,
    `jurisdiction:${input.jurisdiction}`,
    `publicationDate:${input.publicationDate ? input.publicationDate.toISOString() : ''}`,
    `deterministicScore:${input.deterministicScore}`,
    `scoringPolicyVersion:${input.scoringPolicyVersion}`,
    `promptVersion:${input.promptVersion}`,
  ].join('|');
  return sha256Hex(canonical);
}

export interface ResearchInputHashFields {
  researchObjective: string;
  /** blogPostId when present, else suggestionId - the authoritative versioning target. */
  canonicalTargetId: string;
  promptVersion: string;
  researchPolicyVersion: string;
}

/** Bump when the research-pack prompt/source-classification policy changes materially. */
export const RESEARCH_POLICY_VERSION = 'research-pack-policy-v1';

export function computeResearchInputHash(input: ResearchInputHashFields): string {
  const canonical = [
    `target:${input.canonicalTargetId}`,
    `objective:${input.researchObjective.trim().toLowerCase()}`,
    `promptVersion:${input.promptVersion}`,
    `researchPolicyVersion:${input.researchPolicyVersion}`,
  ].join('|');
  return sha256Hex(canonical);
}

export interface ResearchSourceHashInput {
  /** Stable identity for sort/hash purposes - sourceItemId, postSourceId, or a normalized-URL-derived id, in that preference order. */
  stableSourceId: string;
  normalizedUrl: string;
  contentHash?: string | null;
  publicationDate?: Date | null;
  isAvailable: boolean;
  category: string;
  trustLevel: number;
}

/**
 * Hashes the full, sorted source set - never URLs alone (phase-b-data-model.md
 * §2/§11: a source whose content changed behind a stable URL, or whose
 * publicationDate was corrected, must change this hash even though the URL
 * didn't move).
 */
export function computeResearchSourceSetHash(sources: readonly ResearchSourceHashInput[]): string {
  const sorted = [...sources].sort((a, b) => a.stableSourceId.localeCompare(b.stableSourceId));
  const canonical = sorted
    .map((s) =>
      [
        s.stableSourceId,
        s.normalizedUrl,
        s.contentHash ?? '',
        s.publicationDate ? s.publicationDate.toISOString() : '',
        String(s.isAvailable),
        s.category,
        String(s.trustLevel),
      ].join(':'),
    )
    .join('|');
  return sha256Hex(canonical);
}

/** sha256 of BlogPost.content at verification/freshness time - null/empty content hashes consistently, never throws. */
export function computeContentHash(content: string | null | undefined): string {
  return sha256Hex((content ?? '').trim());
}

/** sha256 of normalized claim text - correlates a PRIMARY row with its SECONDARY_REVIEW row for the same underlying claim. */
export function computeClaimHash(claimText: string): string {
  return sha256Hex(claimText.trim().toLowerCase());
}

export interface FallbackSourceHashInput {
  url: string | null;
  updatedAt: Date;
}

/**
 * Fallback-mode source-set hash for BlogPostSource rows (used when semantic
 * verification has no active research pack to reuse a sourceSetHash from).
 * Sorted by URL for determinism regardless of query order.
 */
export function computeFallbackSourceSetHash(sources: readonly FallbackSourceHashInput[]): string {
  const sorted = [...sources].sort((a, b) => (a.url ?? '').localeCompare(b.url ?? ''));
  const canonical = sorted.map((s) => `${s.url ?? ''}:${s.updatedAt.toISOString()}`).join('|');
  return sha256Hex(canonical);
}
