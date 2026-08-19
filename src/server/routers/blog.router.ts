import { TRPCError } from '@trpc/server';
import { router, publicProcedure, adminProcedure } from '../trpc/trpc';
import {
  publicListBlogPostsSchema,
  publicGetBlogPostBySlugSchema,
  publicFeaturedBlogPostsSchema,
  submitBlogFeedbackSchema,
  publicFeedbackSummarySchema,
  submitBlogTopicRequestSchema,
  adminListBlogPostsSchema,
  adminGetBlogPostByIdSchema,
  adminCreateBlogPostSchema,
  adminUpdateBlogPostSchema,
  adminSetBlogPostStatusSchema,
  adminDeleteBlogPostSchema,
} from '../schemas/blog.schema';
import { runPublishReadinessShadowCheck } from '../utils/publish-readiness';
import { publicBlogOrderBy, publicBlogWhere } from '@/modules/blog/public-blog-visibility';
import { BLOG_EDITORIAL_METRIC_SOURCES } from '@/modules/blog/editorial-metrics';
import { hashIp } from '@/utils/request-identifiers';
import { rateLimited } from '../trpc/middleware';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';

const BLOG_ANALYTICS_HASH_PEPPER = (() => {
  const configuredPepper = process.env.BLOG_ANALYTICS_HASH_PEPPER ?? process.env.SUPABASE_JWT_SECRET;
  if (configuredPepper) return configuredPepper;
  if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
    throw new Error('BLOG_ANALYTICS_HASH_PEPPER or SUPABASE_JWT_SECRET is required in deployed environments.');
  }
  return 'development-blog-analytics-pepper';
})();

function hashAnonymousKey(value: string): string {
  return crypto.createHash('sha256').update(`${BLOG_ANALYTICS_HASH_PEPPER}:${value}`).digest('hex');
}

function sanitizeBoundedText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

      const where: Prisma.BlogPostWhereInput = publicBlogWhere();

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
          orderBy: publicBlogOrderBy(),
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
          ...publicBlogWhere(),
          slug: input.slug,
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
    .input(publicFeaturedBlogPostsSchema)
    .query(async ({ input, ctx }) => {
      const posts = await ctx.prisma.blogPost.findMany({
        where: { ...publicBlogWhere(), featured: true },
        take: input.limit,
        orderBy: publicBlogOrderBy(),
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
      where: publicBlogWhere(),
      orderBy: publicBlogOrderBy(),
      select: { slug: true, updatedAt: true, publishedAt: true },
    });
  }),

  publicTaxonomy: publicProcedure.query(async ({ ctx }) => {
    const posts = await ctx.prisma.blogPost.findMany({
      where: publicBlogWhere(),
      orderBy: publicBlogOrderBy(),
      select: {
        category: true,
        tags: true,
      },
    });

    const categoryCounts = new Map<string, number>();
    const tagCounts = new Map<string, number>();

    for (const post of posts) {
      if (post.category?.trim()) {
        const category = post.category.trim();
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      }

      for (const rawTag of post.tags ?? []) {
        const tag = rawTag.trim();
        if (!tag) continue;
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }

    const sortByCountThenName = ([nameA, countA]: [string, number], [nameB, countB]: [string, number]) =>
      countB - countA || nameA.localeCompare(nameB);

    return {
      categories: Array.from(categoryCounts.entries())
        .sort(sortByCountThenName)
        .map(([name, count]) => ({ name, count })),
      tags: Array.from(tagCounts.entries())
        .sort(sortByCountThenName)
        .slice(0, 24)
        .map(([name, count]) => ({ name, count })),
    };
  }),

  submitFeedback: publicProcedure
    .use(rateLimited('blog-submit-feedback', 20, {
      window: 900,
      identifier: (ctx) => hashIp(ctx.req.ip),
    }))
    .input(submitBlogFeedbackSchema)
    .mutation(async ({ input, ctx }) => {
      const post = await ctx.prisma.blogPost.findFirst({
        where: { ...publicBlogWhere(), id: input.postId },
        select: { id: true },
      });

      if (!post) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Blog post not found' });
      }

      const userId = ctx.user?.id;
      const anonymousKeyHash = userId ? null : input.readerSessionId ? hashAnonymousKey(input.readerSessionId) : null;

      if (!userId && !anonymousKeyHash) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'A reader session is required for anonymous feedback.' });
      }

      const data = {
        value: input.value,
        reasonCode: input.reasonCode ?? null,
        userId: userId ?? null,
        anonymousKeyHash,
      };

      if (userId) {
        await ctx.prisma.blogPostFeedback.upsert({
          where: { blogPostId_userId: { blogPostId: post.id, userId } },
          create: { blogPostId: post.id, ...data },
          update: data,
        });
      } else {
        await ctx.prisma.blogPostFeedback.upsert({
          where: { blogPostId_anonymousKeyHash: { blogPostId: post.id, anonymousKeyHash: anonymousKeyHash! } },
          create: { blogPostId: post.id, ...data },
          update: data,
        });
      }

      return { success: true as const };
    }),

  getPublicFeedbackSummary: publicProcedure
    .input(publicFeedbackSummarySchema)
    .query(async ({ input, ctx }) => {
      const post = await ctx.prisma.blogPost.findFirst({
        where: { ...publicBlogWhere(), id: input.postId },
        select: { id: true },
      });

      if (!post) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Blog post not found' });
      }

      const [helpfulCount, notHelpfulCount] = await Promise.all([
        ctx.prisma.blogPostFeedback.count({ where: { blogPostId: post.id, value: 'HELPFUL' } }),
        ctx.prisma.blogPostFeedback.count({ where: { blogPostId: post.id, value: 'NOT_HELPFUL' } }),
      ]);

      return {
        helpfulCount,
        notHelpfulCount,
        totalResponses: helpfulCount + notHelpfulCount,
      };
    }),

  submitTopicRequest: publicProcedure
    .use(rateLimited('blog-submit-topic-request', 5, {
      window: 900,
      identifier: (ctx) => hashIp(ctx.req.ip),
    }))
    .input(submitBlogTopicRequestSchema)
    .mutation(async ({ input, ctx }) => {
      const isSpam = Boolean(input.spamTrap?.trim());
      const topic = sanitizeBoundedText(input.topic);
      if (topic.length < 5) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Topic is too short.' });
      }

      await ctx.prisma.blogTopicRequest.create({
        data: {
          topic,
          category: input.category ? sanitizeBoundedText(input.category) : null,
          jurisdiction: input.jurisdiction ? sanitizeBoundedText(input.jurisdiction) : null,
          sourcePage: input.sourcePage ?? null,
          contactEmail: input.contactEmail?.trim().toLowerCase() ?? null,
          anonymousKeyHash: input.readerSessionId ? hashAnonymousKey(input.readerSessionId) : null,
          spamTrap: input.spamTrap ?? null,
          status: isSpam ? 'SPAM' : 'PENDING',
        },
      });

      return { success: true as const };
    }),

  adminGetEditorialMetricsContract: adminProcedure.query(() => ({
    publicTrendingEnabled: false,
    aggregationArchitecture: 'PostHog engagement events plus durable feedback and marketing records feed scheduled Blog performance snapshots before any public trending API.',
    sources: BLOG_EDITORIAL_METRIC_SOURCES,
  })),

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
        include: { 
          sources: true,
          automationSuggestion: {
            include: {
              sources: {
                include: {
                  sourceItem: {
                    include: { monitor: true }
                  }
                }
              }
            }
          }
        },
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
        include: { 
          sources: true,
          verificationRuns: { orderBy: { createdAt: 'desc' }, take: 1 },
          draftGenerationRuns: { orderBy: { createdAt: 'desc' }, take: 1 }
        },
      });

      if (!post || post.deletedAt) throw new TRPCError({ code: 'NOT_FOUND' });

      const updates: any = { status };

      if (status === 'PUBLISHED') {
        // Pack 1 Stage C5: the shared evaluator runs alongside this existing
        // gate logic in burn-in mode - it never changes this block's outcome
        // unless BLOG_PUBLISH_READINESS_MODE=enforce is explicitly set (not
        // the default). The existing inline checks below are UNCHANGED and
        // remain fully authoritative for the default (shadow) mode. See
        // docs/editorial-intelligence/publish-readiness-burn-in-runbook.md.
        let legacyError: unknown = null;
        try {
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

          const latestVerification = post.verificationRuns[0];
          const latestAiDraft = post.draftGenerationRuns[0];

          if (latestVerification?.status === 'BLOCKED') {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot publish: Source and Claim Verification is BLOCKED.' });
          }

          if (latestAiDraft) {
            const draftTime = latestAiDraft.createdAt;
            const verificationTime = latestVerification ? (latestVerification.completedAt || latestVerification.createdAt) : null;

            if (!verificationTime || draftTime > verificationTime) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot publish: An AI draft was generated but no verification has been run since then.' });
            }
          }
        } catch (err) {
          legacyError = err;
        }

        const shadowCheck = await runPublishReadinessShadowCheck(ctx.prisma, id, legacyError === null, 'adminSetStatus');

        if (legacyError) throw legacyError;

        if (shadowCheck.shouldBlock) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Cannot publish: readiness evaluator blockers: ${shadowCheck.result?.blockers.map((b) => b.code).join(', ')}`,
          });
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
