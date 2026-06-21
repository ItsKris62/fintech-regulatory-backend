import { z } from 'zod';
import { BlogPostStatus, BlogSourceType } from '@prisma/client';

export const blogPostStatusSchema = z.nativeEnum(BlogPostStatus);
export const blogSourceTypeSchema = z.nativeEnum(BlogSourceType);

export const blogSourceSchema = z.object({
  id: z.string().optional(),
  sourceType: blogSourceTypeSchema,
  title: z.string().min(1, 'Title is required'),
  publisher: z.string().optional().nullable(),
  url: z.string().url('Must be a valid URL').optional().nullable().or(z.literal('')),
  publishedAt: z.date().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export const publicListBlogPostsSchema = z.object({
  category: z.string().optional(),
  search: z.string().optional(),
  tag: z.string().optional(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(10),
  featured: z.boolean().optional(),
});

export const publicGetBlogPostBySlugSchema = z.object({
  slug: z.string().min(1),
});

export const adminListBlogPostsSchema = z.object({
  status: blogPostStatusSchema.optional(),
  category: z.string().optional(),
  search: z.string().optional(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(10),
});

export const adminGetBlogPostByIdSchema = z.object({
  id: z.string().min(1),
});

export const adminCreateBlogPostSchema = z.object({
  title: z.string().min(5, 'Title must be at least 5 characters long'),
  slug: z.string().optional(),
  excerpt: z.string().optional(),
  category: z.string().optional(),
});

export const adminUpdateBlogPostSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(5).optional(),
  slug: z.string().optional(),
  excerpt: z.string().optional().nullable(),
  content: z.string().optional().nullable(),
  coverImageUrl: z.string().url().optional().nullable().or(z.literal('')),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  jurisdiction: z.string().optional(),
  relatedRegulations: z.array(z.string()).optional(),
  featured: z.boolean().optional(),
  seoTitle: z.string().optional().nullable(),
  seoDescription: z.string().optional().nullable(),
  canonicalUrl: z.string().url().optional().nullable().or(z.literal('')),
  ogImageUrl: z.string().url().optional().nullable().or(z.literal('')),
  reviewerId: z.string().optional().nullable(),
  sources: z.array(blogSourceSchema).optional(),
});

export const adminSetBlogPostStatusSchema = z.object({
  id: z.string().min(1),
  status: blogPostStatusSchema,
});

export const adminDeleteBlogPostSchema = z.object({
  id: z.string().min(1),
});
