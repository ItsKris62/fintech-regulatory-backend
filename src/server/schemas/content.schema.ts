import { z } from 'zod';

/**
 * Content Schemas
 *
 * Zod validation schemas for blog posts, knowledge base articles,
 * and other content management operations.
 */

export const contentTypeEnum = z.enum([
  'REGULATORY_DOCUMENT',
  'BLOG_POST',
  'KNOWLEDGE_BASE_ARTICLE',
  'POLICY_TEMPLATE',
]);

export const contentStatusEnum = z.enum([
  'DRAFT',
  'PUBLISHED',
  'ARCHIVED',
  'UNDER_REVIEW',
]);

/**
 * Create blog post or KB article
 */
export const createContentSchema = z.object({
  contentType: contentTypeEnum.exclude(['REGULATORY_DOCUMENT']),
  title: z.string().min(3).max(200),
  slug: z.string().min(3).max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Slug must be lowercase alphanumeric with hyphens only',
  }).optional(),
  excerpt: z.string().max(500).optional(),
  content: z.string().min(1),
  category: z.string().max(100).optional(),
  subcategory: z.string().max(100).optional(),
  tags: z.array(z.string().max(50)).max(20).default([]),
  seoTitle: z.string().max(70).optional(),
  seoDescription: z.string().max(160).optional(),
  seoKeywords: z.array(z.string().max(50)).max(10).default([]),
  status: contentStatusEnum.default('DRAFT'),
});

export type CreateContentInput = z.infer<typeof createContentSchema>;

/**
 * Update content
 */
export const updateContentSchema = z.object({
  id: z.string(),
  title: z.string().min(3).max(200).optional(),
  slug: z.string().min(3).max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Slug must be lowercase alphanumeric with hyphens only',
  }).optional(),
  excerpt: z.string().max(500).optional(),
  content: z.string().min(1).optional(),
  category: z.string().max(100).optional(),
  subcategory: z.string().max(100).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  seoTitle: z.string().max(70).optional(),
  seoDescription: z.string().max(160).optional(),
  seoKeywords: z.array(z.string().max(50)).max(10).optional(),
  status: contentStatusEnum.optional(),
});

export type UpdateContentInput = z.infer<typeof updateContentSchema>;

/**
 * List content with filtering
 */
export const listContentSchema = z.object({
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
  contentType: contentTypeEnum.optional(),
  status: contentStatusEnum.optional(),
  category: z.string().optional(),
  tag: z.string().optional(),
  search: z.string().max(200).optional(),
  authorId: z.string().optional(),
});

export type ListContentInput = z.infer<typeof listContentSchema>;

/**
 * Get content by ID
 */
export const getContentSchema = z.object({
  id: z.string(),
});

export type GetContentInput = z.infer<typeof getContentSchema>;

/**
 * Get content by slug (public)
 */
export const getContentBySlugSchema = z.object({
  slug: z.string(),
});

export type GetContentBySlugInput = z.infer<typeof getContentBySlugSchema>;

/**
 * Publish content
 */
export const publishContentSchema = z.object({
  id: z.string(),
});

export type PublishContentInput = z.infer<typeof publishContentSchema>;

/**
 * Delete content
 */
export const deleteContentSchema = z.object({
  id: z.string(),
});

export type DeleteContentInput = z.infer<typeof deleteContentSchema>;

/**
 * Rate content (helpful/not helpful)
 */
export const rateContentSchema = z.object({
  id: z.string(),
  helpful: z.boolean(),
});

export type RateContentInput = z.infer<typeof rateContentSchema>;
