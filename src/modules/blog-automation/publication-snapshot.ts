import { createHash } from 'node:crypto';
import type { BlogDraftGenerationRun, BlogPost, BlogPostSource, BlogVerificationRun } from '@prisma/client';
import { computeContentHash, computeFallbackSourceSetHash } from './editorial-input-hash';

export const BLOG_PUBLICATION_SNAPSHOT_VERSION = 'blog-publication-snapshot-v1';

export interface BlogPublicationSnapshot {
  version: typeof BLOG_PUBLICATION_SNAPSHOT_VERSION;
  blogPostId: string;
  contentHash: string;
  sourceSetHash: string;
  publicationPayloadHash: string;
  draftGenerationRunId: string | null;
  verificationRunId: string | null;
  postUpdatedAt: string;
  computedAt: string;
}

type SnapshotPost = Pick<
  BlogPost,
  'id' | 'title' | 'slug' | 'excerpt' | 'content' | 'category' | 'jurisdiction' | 'tags' | 'relatedRegulations' | 'updatedAt'
> & {
  sources: Pick<BlogPostSource, 'url' | 'updatedAt'>[];
  draftGenerationRuns: Pick<BlogDraftGenerationRun, 'id'>[];
  verificationRuns: Pick<BlogVerificationRun, 'id'>[];
};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeBlogPublicationSnapshot(post: SnapshotPost, computedAt: Date = new Date()): BlogPublicationSnapshot {
  const contentHash = computeContentHash(post.content);
  const sourceSetHash = computeFallbackSourceSetHash(post.sources.map((source) => ({ url: source.url, updatedAt: source.updatedAt })));
  const publicationPayloadHash = sha256Hex(stableStringify({
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    contentHash,
    category: post.category,
    jurisdiction: post.jurisdiction,
    tags: post.tags,
    relatedRegulations: post.relatedRegulations,
    sourceSetHash,
  }));

  return {
    version: BLOG_PUBLICATION_SNAPSHOT_VERSION,
    blogPostId: post.id,
    contentHash,
    sourceSetHash,
    publicationPayloadHash,
    draftGenerationRunId: post.draftGenerationRuns[0]?.id ?? null,
    verificationRunId: post.verificationRuns[0]?.id ?? null,
    postUpdatedAt: post.updatedAt.toISOString(),
    computedAt: computedAt.toISOString(),
  };
}

export function parseBlogPublicationSnapshot(value: unknown): BlogPublicationSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== BLOG_PUBLICATION_SNAPSHOT_VERSION ||
    typeof candidate.blogPostId !== 'string' ||
    typeof candidate.contentHash !== 'string' ||
    typeof candidate.sourceSetHash !== 'string' ||
    typeof candidate.publicationPayloadHash !== 'string' ||
    typeof candidate.postUpdatedAt !== 'string' ||
    typeof candidate.computedAt !== 'string'
  ) {
    return null;
  }

  const draftGenerationRunId = candidate.draftGenerationRunId;
  const verificationRunId = candidate.verificationRunId;
  if (draftGenerationRunId !== null && typeof draftGenerationRunId !== 'string') return null;
  if (verificationRunId !== null && typeof verificationRunId !== 'string') return null;

  return {
    version: BLOG_PUBLICATION_SNAPSHOT_VERSION,
    blogPostId: candidate.blogPostId,
    contentHash: candidate.contentHash,
    sourceSetHash: candidate.sourceSetHash,
    publicationPayloadHash: candidate.publicationPayloadHash,
    draftGenerationRunId,
    verificationRunId,
    postUpdatedAt: candidate.postUpdatedAt,
    computedAt: candidate.computedAt,
  };
}
