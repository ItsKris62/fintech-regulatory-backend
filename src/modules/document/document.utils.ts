/**
 * Document Module Utilities
 * Validation schemas, transformation helpers, text extraction utilities
 */

import { z } from 'zod';
import { nanoid } from 'nanoid';
import type {
  DocumentSummary,
  BlogPost,
  KBArticle,
  ShareLink,
} from './document.types';

// ============================================================================
// Validation Schemas
// ============================================================================

export const uploadDocumentSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  metadata: z
    .object({
      actName: z.string().optional(),
      documentType: z.string().optional(),
      regulatoryBody: z.string().optional(),
      tags: z.array(z.string()).optional(),
      category: z.string().optional(),
      subcategory: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      title: z.string().optional(),
      summary: z.string().optional(),
    })
    .optional(),
  autoProcess: z.boolean().default(true),
});

export const documentFiltersSchema = z.object({
  contentType: z.string().optional(),
  contentStatus: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  searchQuery: z.string().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  page: z.number().int().positive().default(1),
  limit: z.number().int().min(1).max(100).default(20),
  sortBy: z.enum(['createdAt', 'updatedAt', 'viewCount', 'actName']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const searchFiltersSchema = z.object({
  contentType: z.string().optional(),
  category: z.string().optional(),
  organizationId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  topK: z.number().int().min(1).max(50).default(10),
  minScore: z.number().min(0).max(1).default(0.65),
});

export const shareParamsSchema = z.object({
  expiresAt: z.string().datetime().optional(),
  maxDownloads: z.number().int().positive().optional(),
  message: z.string().max(500).optional(),
});

export const blogPostSchema = z.object({
  title: z.string().min(3).max(255),
  content: z.string().min(10),
  htmlContent: z.string().optional(),
  excerpt: z.string().max(500).optional(),
  tags: z.array(z.string()).max(10).default([]),
  category: z.string().optional(),
  seoTitle: z.string().max(60).optional(),
  seoDescription: z.string().max(160).optional(),
  seoKeywords: z.array(z.string()).max(10).optional(),
  slug: z.string().regex(/^[a-z0-9-]+$/).optional(),
});

export const kbArticleSchema = z.object({
  title: z.string().min(3).max(255),
  content: z.string().min(10),
  htmlContent: z.string().optional(),
  excerpt: z.string().max(500).optional(),
  tags: z.array(z.string()).max(10).default([]),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  slug: z.string().regex(/^[a-z0-9-]+$/).optional(),
});

export const metadataUpdateSchema = z.object({
  actName: z.string().optional(),
  documentType: z.string().optional(),
  regulatoryBody: z.string().optional(),
  tags: z.array(z.string()).optional(),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
});

// ============================================================================
// Slug Generation
// ============================================================================

/**
 * Generate a URL-safe slug from a title
 */
export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 200);
}

/**
 * Generate a unique share token
 */
export function generateShareToken(): string {
  return nanoid(32);
}

/**
 * Generate a unique document key for storage
 */
export function generateStorageKey(userId: string, filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const id = nanoid(16);
  return `documents/${userId}/${id}.${ext}`;
}

// ============================================================================
// Text Extraction (lightweight implementation)
// ============================================================================

/**
 * Extract plain text from a TXT file buffer
 */
export function extractTextFromTxt(buffer: Buffer): string {
  return buffer.toString('utf-8');
}

/**
 * Extract plain text from a Markdown file buffer
 */
export function extractTextFromMarkdown(buffer: Buffer): string {
  const raw = buffer.toString('utf-8');
  // Strip markdown syntax for plain text indexing
  return raw
    .replace(/#{1,6}\s/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`{3}[\s\S]*?`{3}/g, '')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/!\[.+?\]\(.+?\)/g, '')
    .replace(/^\s*[-*+]\s/gm, '')
    .replace(/^\s*\d+\.\s/gm, '')
    .trim();
}

/**
 * Attempt to extract text from a buffer based on MIME type.
 * For PDF/DOCX, returns null — those need the pdf-parse/mammoth packages
 * which are optional additions. The module gracefully handles the absence.
 */
export async function extractText(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<string | null> {
  try {
    if (mimeType === 'text/plain') {
      return extractTextFromTxt(buffer);
    }

    if (mimeType === 'text/markdown' || filename.endsWith('.md')) {
      return extractTextFromMarkdown(buffer);
    }

    if (mimeType === 'text/html') {
      // Strip HTML tags for plain text
      return buffer.toString('utf-8').replace(/<[^>]+>/g, ' ').trim();
    }

    if (mimeType === 'application/pdf') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pdfParse = require('pdf-parse') as (b: Buffer) => Promise<{ text: string }>;
        const result = await pdfParse(buffer);
        return result.text;
      } catch {
        // pdf-parse not installed — log warning and continue without text
        return null;
      }
    }

    if (
      mimeType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mammoth = require('mammoth') as {
          extractRawText: (o: { buffer: Buffer }) => Promise<{ value: string }>;
        };
        const result = await mammoth.extractRawText({ buffer });
        return result.value;
      } catch {
        return null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Data Transformers
// ============================================================================

export function toDocumentSummary(doc: Record<string, unknown>): DocumentSummary {
  return {
    id: doc.id as string,
    actName: doc.actName as string,
    title: doc.title as string | null,
    documentType: doc.documentType as string,
    contentType: doc.contentType as string,
    contentStatus: doc.contentStatus as string,
    status: doc.status as string,
    fileUrl: doc.fileUrl as string,
    fileSize: doc.fileSize as number,
    mimeType: doc.mimeType as string,
    category: doc.category as string | null,
    tags: (doc.tags as string[]) ?? [],
    viewCount: doc.viewCount as number,
    version: doc.version as number,
    isLatestVersion: doc.isLatestVersion as boolean,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

export function toBlogPost(doc: Record<string, unknown>): BlogPost {
  return {
    id: doc.id as string,
    title: (doc.title ?? doc.actName) as string,
    slug: doc.slug as string,
    content: doc.content as string,
    htmlContent: doc.htmlContent as string | null,
    excerpt: doc.excerpt as string | null,
    tags: (doc.tags as string[]) ?? [],
    category: doc.category as string | null,
    contentStatus: doc.contentStatus as string,
    viewCount: doc.viewCount as number,
    authorId: doc.authorId as string | null,
    publishedAt: doc.publishedAt as Date | null,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

export function toKBArticle(doc: Record<string, unknown>): KBArticle {
  return {
    id: doc.id as string,
    title: (doc.title ?? doc.actName) as string,
    slug: doc.slug as string,
    content: doc.content as string,
    htmlContent: doc.htmlContent as string | null,
    excerpt: doc.excerpt as string | null,
    tags: (doc.tags as string[]) ?? [],
    category: doc.category as string | null,
    subcategory: doc.subcategory as string | null,
    contentStatus: doc.contentStatus as string,
    viewCount: doc.viewCount as number,
    helpfulCount: doc.helpfulCount as number,
    notHelpfulCount: doc.notHelpfulCount as number,
    authorId: doc.authorId as string | null,
    publishedAt: doc.publishedAt as Date | null,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

export function toShareLink(share: Record<string, unknown>, appUrl: string): ShareLink {
  return {
    id: share.id as string,
    documentId: share.documentId as string,
    token: share.token as string,
    shareUrl: `${appUrl}/shared/${share.token as string}`,
    expiresAt: share.expiresAt as Date | null,
    maxDownloads: share.maxDownloads as number | null,
    downloads: share.downloads as number,
    createdAt: share.createdAt as Date,
  };
}

// ============================================================================
// Cache Key Helpers
// ============================================================================

export function docCacheKey(documentId: string): string {
  return `doc:${documentId}`;
}

export function orgDocsCacheKey(orgId: string, page: number, limit: number): string {
  return `doc:org:${orgId}:${page}:${limit}`;
}

export function searchCacheKey(query: string, orgId: string): string {
  const sanitized = query.toLowerCase().replace(/\s+/g, '_').substring(0, 50);
  return `doc:search:${orgId}:${sanitized}`;
}
