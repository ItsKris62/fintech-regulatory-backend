import { TRPCError } from '@trpc/server';
import { router, publicProcedure, adminProcedure } from '../trpc/trpc';
import {
  publicListBlogPostsSchema,
  publicGetBlogPostBySlugSchema,
  adminListBlogPostsSchema,
  adminGetBlogPostByIdSchema,
  adminCreateBlogPostSchema,
  adminUpdateBlogPostSchema,
  adminSetBlogPostStatusSchema,
  adminDeleteBlogPostSchema,
} from '../schemas/blog.schema';
import { z } from 'zod';

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function calculateReadingTime(content: string | null): number {
  if (!content) return 1;
  const words = content.trim().split(/\s+/).length;
  const time = Math.ceil(words / 200);
  return Math.max(1, time);
}

export const blogRouter = router({
  publicList: publicProcedure
    .input(publicListBlogPostsSchema)
    .query(async ({ input, ctx }) => {
      const { category, search, tag, page, limit, featured } = input;
      const skip = (page - 1) * limit;

      const where: any = {
        status: 'PUBLISHED',
        deletedAt: null,
        publishedAt: { not: null },
      };

      if (category) where.category = category;
      if (tag) where.tags = { has: tag };
      if (featured !== undefined) where.featured = featured;

      if (search) {
        where.OR = [
          { title: { contains: search, mode: 'insensitive' } },
          { excerpt: { contains: search, mode: 'insensitive' } },
          { content: { contains: search, mode: 'insensitive' } },
        ];
      }

      const [posts, total] = await Promise.all([
        ctx.prisma.blogPost.findMany({
          where,
          skip,
          take: limit,
          orderBy: { publishedAt: 'desc' },
          select: {
            id: true,
            title: true,
            slug: true,
            excerpt: true,
            category: true,
            tags: true,
            featured: true,
            coverImageUrl: true,
            publishedAt: true,
            updatedAt: true,
            lastReviewedAt: true,
            content: true,
            author: { select: { id: true, fullName: true } },
            _count: { select: { sources: true } },
          },
        }),
        ctx.prisma.blogPost.count({ where }),
      ]);

      const mappedPosts = posts.map(post => {
        const { content, _count, ...rest } = post;
        return {
          ...rest,
          readingTime: calculateReadingTime(content),
          sourceCount: _count.sources,
        };
      });

      return {
        posts: mappedPosts,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      };
    }),

  publicGetBySlug: publicProcedure
    .input(publicGetBlogPostBySlugSchema)
    .query(async ({ input, ctx }) => {
      const post = await ctx.prisma.blogPost.findFirst({
        where: {
          slug: input.slug,
          status: 'PUBLISHED',
          deletedAt: null,
        },
        include: {
          author: { select: { id: true, fullName: true } },
          sources: true,
        },
      });

      if (!post) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Blog post not found' });
      }

      return {
        ...post,
        readingTime: calculateReadingTime(post.content),
      };
    }),

  getFeatured: publicProcedure
    .input(z.object({ limit: z.number().optional().default(3) }))
    .query(async ({ input, ctx }) => {
      const posts = await ctx.prisma.blogPost.findMany({
        where: { status: 'PUBLISHED', deletedAt: null, featured: true },
        take: input.limit,
        orderBy: { publishedAt: 'desc' },
        select: {
          id: true,
          title: true,
          slug: true,
          excerpt: true,
          category: true,
          tags: true,
          featured: true,
          coverImageUrl: true,
          publishedAt: true,
          updatedAt: true,
          lastReviewedAt: true,
          content: true,
          author: { select: { id: true, fullName: true } },
          _count: { select: { sources: true } },
        },
      });

      return posts.map(post => {
        const { content, _count, ...rest } = post;
        return {
          ...rest,
          readingTime: calculateReadingTime(content),
          sourceCount: _count.sources,
        };
      });
    }),

  publicSlugs: publicProcedure.query(async ({ ctx }) => {
    return ctx.prisma.blogPost.findMany({
      where: { status: 'PUBLISHED', deletedAt: null },
      select: { slug: true, updatedAt: true, publishedAt: true },
    });
  }),

  adminList: adminProcedure
    .input(adminListBlogPostsSchema)
    .query(async ({ input, ctx }) => {
      const { status, category, search, page, limit } = input;
      const skip = (page - 1) * limit;

      const where: any = { deletedAt: null };
      if (status) where.status = status;
      if (category) where.category = category;

      if (search) {
        where.OR = [
          { title: { contains: search, mode: 'insensitive' } },
          { excerpt: { contains: search, mode: 'insensitive' } },
        ];
      }

      const [posts, total] = await Promise.all([
        ctx.prisma.blogPost.findMany({
          where,
          skip,
          take: limit,
          orderBy: { updatedAt: 'desc' },
          include: {
            author: { select: { id: true, fullName: true } },
            reviewer: { select: { id: true, fullName: true } },
            _count: { select: { sources: true } },
          },
        }),
        ctx.prisma.blogPost.count({ where }),
      ]);

      return {
        posts: posts.map(p => ({ ...p, sourceCount: p._count.sources })),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      };
    }),

  adminGetById: adminProcedure
    .input(adminGetBlogPostByIdSchema)
    .query(async ({ input, ctx }) => {
      const post = await ctx.prisma.blogPost.findUnique({
        where: { id: input.id },
        include: { sources: true },
      });
      if (!post || post.deletedAt) throw new TRPCError({ code: 'NOT_FOUND' });
      return post;
    }),

  adminCreate: adminProcedure
    .input(adminCreateBlogPostSchema)
    .mutation(async ({ input, ctx }) => {
      let slug = input.slug || generateSlug(input.title);
      
      const existingSlug = await ctx.prisma.blogPost.findUnique({ where: { slug } });
      if (existingSlug) {
        slug = `${slug}-${Date.now()}`;
      }

      return ctx.prisma.blogPost.create({
        data: {
          title: input.title,
          slug,
          excerpt: input.excerpt,
          category: input.category || 'Compliance Guides',
          authorId: ctx.user!.id,
          status: 'DRAFT',
        },
      });
    }),

  adminUpdate: adminProcedure
    .input(adminUpdateBlogPostSchema)
    .mutation(async ({ input, ctx }) => {
      const { id, sources, ...data } = input;

      const post = await ctx.prisma.blogPost.findUnique({ where: { id } });
      if (!post || post.deletedAt) throw new TRPCError({ code: 'NOT_FOUND' });

      if (data.slug && data.slug !== post.slug) {
        const existing = await ctx.prisma.blogPost.findUnique({ where: { slug: data.slug } });
        if (existing) throw new TRPCError({ code: 'CONFLICT', message: 'Slug already exists' });
      }

      return ctx.prisma.$transaction(async (tx) => {
        const updated = await tx.blogPost.update({
          where: { id },
          data: {
            ...data,
            updatedById: ctx.user!.id,
          },
        });

        if (sources) {
          await tx.blogPostSource.deleteMany({ where: { postId: id } });
          if (sources.length > 0) {
            await tx.blogPostSource.createMany({
              data: sources.map(s => ({
                postId: id,
                sourceType: s.sourceType,
                title: s.title,
                publisher: s.publisher,
                url: s.url,
                publishedAt: s.publishedAt,
                notes: s.notes,
              })),
            });
          }
        }

        return updated;
      });
    }),

  adminSetStatus: adminProcedure
    .input(adminSetBlogPostStatusSchema)
    .mutation(async ({ input, ctx }) => {
      const { id, status } = input;
      const post = await ctx.prisma.blogPost.findUnique({
        where: { id },
        include: { sources: true },
      });

      if (!post || post.deletedAt) throw new TRPCError({ code: 'NOT_FOUND' });

      const updates: any = { status };

      if (status === 'PUBLISHED') {
        if (!post.title || !post.slug || !post.excerpt || !post.content || !post.category) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing required fields for publishing' });
        }

        if (post.sources.length === 0) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'At least one source is required for publishing' });
        }

        if (['Regulatory Updates', 'Enforcement & Penalties'].includes(post.category)) {
          if (!post.sources.some(s => s.sourceType === 'OFFICIAL')) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: `${post.category} requires an OFFICIAL source` });
          }
        } else if (post.category === 'International Standards') {
          if (!post.sources.some(s => ['OFFICIAL', 'INTERNATIONAL_STANDARD'].includes(s.sourceType))) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: `International Standards requires an OFFICIAL or INTERNATIONAL_STANDARD source` });
          }
        }

        if (!post.publishedAt) updates.publishedAt = new Date();
        if (!post.lastReviewedAt) updates.lastReviewedAt = new Date();
      } else if (status === 'ARCHIVED') {
        updates.archivedAt = new Date();
      }

      return ctx.prisma.blogPost.update({
        where: { id },
        data: updates,
      });
    }),

  adminDelete: adminProcedure
    .input(adminDeleteBlogPostSchema)
    .mutation(async ({ input, ctx }) => {
      return ctx.prisma.blogPost.update({
        where: { id: input.id },
        data: { deletedAt: new Date() },
      });
    }),
});
