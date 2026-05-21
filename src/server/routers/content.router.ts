import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, publicProcedure } from '../trpc/trpc';
import {
  createContentSchema,
  updateContentSchema,
  listContentSchema,
  getContentSchema,
  getContentBySlugSchema,
  publishContentSchema,
  deleteContentSchema,
  rateContentSchema,
} from '../schemas/content.schema';
import { ContentService } from '@/lib/content/content.service';
import { rateLimiter } from '@/lib/redis/rate-limiter';
import { logger } from '@/utils/logger';
import { hashIp } from '@/utils/request-identifiers';

/**
 * Content Router
 *
 * Handles CRUD operations for blog posts, knowledge base articles,
 * and policy templates. Supports publishing workflows, versioning,
 * and engagement tracking.
 */
export const contentRouter = router({
  /**
   * Create a new blog post or KB article
   *
   * @protected
   */
  create: protectedProcedure
    .input(createContentSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const contentService = new ContentService(ctx.prisma as any);

        // Generate slug from title if not provided
        const slug = input.slug || (await contentService.generateSlug(input.title));

        // Check slug uniqueness
        if (await contentService.slugExists(slug)) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Slug "${slug}" is already in use`,
          });
        }

        // Render markdown to HTML
        const htmlContent = contentService.renderMarkdown(input.content);

        // Generate excerpt if not provided
        const excerpt = input.excerpt || contentService.generateExcerpt(input.content);

        const document = await ctx.prisma.legalDocument.create({
          data: {
            // Required base fields with sensible defaults for content items
            actName: input.title,
            documentType: input.contentType,
            originalFilename: `${slug}.md`,
            fileUrl: '',
            fileSize: Buffer.byteLength(input.content, 'utf8'),
            mimeType: 'text/markdown',

            // Content classification
            contentType: input.contentType,
            contentStatus: input.status,

            // Content fields
            title: input.title,
            slug,
            excerpt,
            content: input.content,
            htmlContent,

            // Categorization
            tags: input.tags,
            category: input.category,
            subcategory: input.subcategory,

            // SEO
            seoTitle: input.seoTitle || input.title,
            seoDescription: input.seoDescription || excerpt,
            seoKeywords: input.seoKeywords,

            // Ownership
            authorId: ctx.user.id,
            userId: ctx.user.id,
            organizationId: ctx.user.organizationId,

            // Publishing
            publishedAt: input.status === 'PUBLISHED' ? new Date() : null,
            publishedBy: input.status === 'PUBLISHED' ? ctx.user.id : null,

            // Defaults
            keywords: input.tags,
            amendedBy: [],
          },
        });

        logger.info({
          type: 'content_created',
          userId: ctx.user.id,
          documentId: document.id,
          contentType: input.contentType,
          slug,
        });

        return {
          id: document.id,
          slug: document.slug,
          contentType: document.contentType,
          contentStatus: document.contentStatus,
          title: document.title,
          createdAt: document.createdAt,
        };
      } catch (error: any) {
        logger.error({
          type: 'content_create_error',
          userId: ctx.user.id,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create content',
          cause: error,
        });
      }
    }),

  /**
   * Update existing content
   *
   * @protected
   */
  update: protectedProcedure
    .input(updateContentSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const existing = await ctx.prisma.legalDocument.findUnique({
          where: { id: input.id },
          select: { id: true, authorId: true, userId: true, organizationId: true, deletedAt: true },
        });

        if (!existing || existing.deletedAt) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Content not found' });
        }

        // Access check: author, owner, or admin
        if (
          ctx.user.role !== 'ADMIN' &&
          existing.authorId !== ctx.user.id &&
          existing.userId !== ctx.user.id
        ) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }

        const contentService = new ContentService(ctx.prisma as any);

        // Validate slug uniqueness if changing
        if (input.slug && (await contentService.slugExists(input.slug, input.id))) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Slug "${input.slug}" is already in use`,
          });
        }

        const data: Record<string, any> = {};

        if (input.title !== undefined) {
          data.title = input.title;
          data.actName = input.title;
        }
        if (input.slug !== undefined) data.slug = input.slug;
        if (input.excerpt !== undefined) data.excerpt = input.excerpt;
        if (input.category !== undefined) data.category = input.category;
        if (input.subcategory !== undefined) data.subcategory = input.subcategory;
        if (input.tags !== undefined) {
          data.tags = input.tags;
          data.keywords = input.tags;
        }
        if (input.seoTitle !== undefined) data.seoTitle = input.seoTitle;
        if (input.seoDescription !== undefined) data.seoDescription = input.seoDescription;
        if (input.seoKeywords !== undefined) data.seoKeywords = input.seoKeywords;
        if (input.status !== undefined) data.contentStatus = input.status;

        if (input.content !== undefined) {
          data.content = input.content;
          data.htmlContent = contentService.renderMarkdown(input.content);
          data.fileSize = Buffer.byteLength(input.content, 'utf8');
          if (!input.excerpt) {
            data.excerpt = contentService.generateExcerpt(input.content);
          }
        }

        if (input.status === 'PUBLISHED') {
          data.publishedAt = new Date();
          data.publishedBy = ctx.user.id;
        }

        const document = await ctx.prisma.legalDocument.update({
          where: { id: input.id },
          data,
        });

        logger.info({
          type: 'content_updated',
          userId: ctx.user.id,
          documentId: document.id,
        });

        return {
          id: document.id,
          slug: document.slug,
          contentStatus: document.contentStatus,
          title: document.title,
          updatedAt: document.updatedAt,
        };
      } catch (error: any) {
        logger.error({
          type: 'content_update_error',
          userId: ctx.user.id,
          documentId: input.id,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update content',
          cause: error,
        });
      }
    }),

  /**
   * List content with filtering and pagination
   *
   * @protected
   */
  list: protectedProcedure
    .input(listContentSchema)
    .query(async ({ input, ctx }) => {
      try {
        const { page, limit, contentType, status, category, tag, search, authorId } = input;
        const skip = (page - 1) * limit;

        const where: any = {
          deletedAt: null,
          isLatestVersion: true,
          // Exclude regulatory documents from content listing
          contentType: contentType || { not: 'REGULATORY_DOCUMENT' },
        };

        if (status) where.contentStatus = status;
        if (category) where.category = category;
        if (authorId) where.authorId = authorId;
        if (tag) where.tags = { has: tag };

        if (search) {
          where.OR = [
            { title: { contains: search, mode: 'insensitive' } },
            { excerpt: { contains: search, mode: 'insensitive' } },
            { content: { contains: search, mode: 'insensitive' } },
          ];
        }

        // Non-admin users can only see published content or their own
        if (ctx.user.role !== 'ADMIN') {
          where.AND = [
            {
              OR: [
                { contentStatus: 'PUBLISHED' },
                { authorId: ctx.user.id },
                { userId: ctx.user.id },
              ],
            },
          ];
        }

        const [documents, total] = await Promise.all([
          ctx.prisma.legalDocument.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              contentType: true,
              contentStatus: true,
              title: true,
              slug: true,
              excerpt: true,
              category: true,
              subcategory: true,
              tags: true,
              authorId: true,
              publishedAt: true,
              viewCount: true,
              helpfulCount: true,
              version: true,
              createdAt: true,
              updatedAt: true,
              author: {
                select: {
                  id: true,
                  fullName: true,
                  avatar: true,
                },
              },
            },
          }),
          ctx.prisma.legalDocument.count({ where }),
        ]);

        return {
          items: documents,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
          },
        };
      } catch (error: any) {
        logger.error({
          type: 'content_list_error',
          userId: ctx.user.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to list content',
          cause: error,
        });
      }
    }),

  /**
   * Get content by ID
   *
   * @protected
   */
  get: protectedProcedure
    .input(getContentSchema)
    .query(async ({ input, ctx }) => {
      try {
        const document = await ctx.prisma.legalDocument.findUnique({
          where: { id: input.id },
          include: {
            author: {
              select: { id: true, fullName: true, avatar: true },
            },
            publisher: {
              select: { id: true, fullName: true },
            },
          },
        });

        if (!document || document.deletedAt) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Content not found' });
        }

        // Non-admin can only see published or own content
        if (
          ctx.user.role !== 'ADMIN' &&
          document.contentStatus !== 'PUBLISHED' &&
          document.authorId !== ctx.user.id &&
          document.userId !== ctx.user.id
        ) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }

        return document;
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get content',
          cause: error,
        });
      }
    }),

  /**
   * Get published content by slug (public endpoint)
   */
  getBySlug: publicProcedure
    .input(getContentBySlugSchema)
    .query(async ({ input, ctx }) => {
      try {
        const rlResult = await rateLimiter.check(hashIp(ctx.req.ip), 'content-get-by-slug', 60, 60);
        if (!rlResult.allowed) {
          const suffix = rlResult.retryAfter ? ` Try again in ${rlResult.retryAfter} seconds.` : '';
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: `Too many content requests.${suffix}`,
          });
        }

        const document = await ctx.prisma.legalDocument.findUnique({
          where: { slug: input.slug },
          include: {
            author: {
              select: { id: true, fullName: true, avatar: true },
            },
          },
        });

        if (!document || document.deletedAt || document.contentStatus !== 'PUBLISHED') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Content not found' });
        }

        // Increment view count in background
        const contentService = new ContentService(ctx.prisma as any);
        contentService.incrementViewCount(document.id);

        return {
          id: document.id,
          contentType: document.contentType,
          title: document.title,
          slug: document.slug,
          excerpt: document.excerpt,
          htmlContent: document.htmlContent,
          content: document.content,
          category: document.category,
          subcategory: document.subcategory,
          tags: document.tags,
          seoTitle: document.seoTitle,
          seoDescription: document.seoDescription,
          seoKeywords: document.seoKeywords,
          publishedAt: document.publishedAt,
          viewCount: document.viewCount,
          helpfulCount: document.helpfulCount,
          notHelpfulCount: document.notHelpfulCount,
          author: document.author,
        };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get content',
          cause: error,
        });
      }
    }),

  /**
   * Publish content
   *
   * @protected
   */
  publish: protectedProcedure
    .input(publishContentSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const document = await ctx.prisma.legalDocument.findUnique({
          where: { id: input.id },
          select: {
            id: true,
            contentStatus: true,
            slug: true,
            authorId: true,
            userId: true,
            deletedAt: true,
          },
        });

        if (!document || document.deletedAt) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Content not found' });
        }

        if (
          ctx.user.role !== 'ADMIN' &&
          document.authorId !== ctx.user.id &&
          document.userId !== ctx.user.id
        ) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }

        if (!document.slug) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Content must have a slug before publishing',
          });
        }

        const updated = await ctx.prisma.legalDocument.update({
          where: { id: input.id },
          data: {
            contentStatus: 'PUBLISHED',
            publishedAt: new Date(),
            publishedBy: ctx.user.id,
          },
        });

        logger.info({
          type: 'content_published',
          userId: ctx.user.id,
          documentId: input.id,
          slug: document.slug,
        });

        return {
          id: updated.id,
          slug: updated.slug,
          contentStatus: updated.contentStatus,
          publishedAt: updated.publishedAt,
        };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to publish content',
          cause: error,
        });
      }
    }),

  /**
   * Soft delete content
   *
   * @protected
   */
  delete: protectedProcedure
    .input(deleteContentSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const document = await ctx.prisma.legalDocument.findUnique({
          where: { id: input.id },
          select: { id: true, authorId: true, userId: true, deletedAt: true },
        });

        if (!document || document.deletedAt) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Content not found' });
        }

        if (
          ctx.user.role !== 'ADMIN' &&
          document.authorId !== ctx.user.id &&
          document.userId !== ctx.user.id
        ) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }

        await ctx.prisma.legalDocument.update({
          where: { id: input.id },
          data: { deletedAt: new Date() },
        });

        logger.info({
          type: 'content_deleted',
          userId: ctx.user.id,
          documentId: input.id,
        });

        return { success: true, message: 'Content deleted successfully' };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete content',
          cause: error,
        });
      }
    }),

  /**
   * Rate content as helpful or not helpful
   *
   * @protected
   */
  rate: protectedProcedure
    .input(rateContentSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const document = await ctx.prisma.legalDocument.findUnique({
          where: { id: input.id },
          select: { id: true, contentStatus: true, deletedAt: true },
        });

        if (!document || document.deletedAt) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Content not found' });
        }

        const contentService = new ContentService(ctx.prisma as any);
        await contentService.rateContent(input.id, input.helpful);

        logger.info({
          type: 'content_rated',
          userId: ctx.user.id,
          documentId: input.id,
          helpful: input.helpful,
        });

        return { success: true };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to rate content',
          cause: error,
        });
      }
    }),
});
