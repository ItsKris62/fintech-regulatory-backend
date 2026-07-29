import { Prisma } from '@prisma/client';

/**
 * Canonical public visibility rule for SheriaBot BlogPost records.
 *
 * Archived posts are not public in the current product policy: archiving sets
 * status=ARCHIVED and archivedAt, while public blog surfaces require
 * status=PUBLISHED and archivedAt=null.
 */
export function publicBlogWhere(now: Date = new Date()): Prisma.BlogPostWhereInput {
  return {
    status: 'PUBLISHED',
    deletedAt: null,
    archivedAt: null,
    publishedAt: {
      not: null,
      lte: now,
    },
  };
}

export function publicBlogOrderBy(): Prisma.BlogPostOrderByWithRelationInput[] {
  return [{ publishedAt: 'desc' }, { id: 'desc' }];
}
