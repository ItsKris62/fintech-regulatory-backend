import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';

export class BlogEditorialDigestService {
  /**
   * Generates a blog editorial digest for the specified period.
   * By default, calculates for the last 7 days.
   * If a digest already exists for this exact period, it will return the existing one
   * unless force=true is passed.
   */
  async generateBlogEditorialDigest(params?: { periodStart?: Date; periodEnd?: Date; force?: boolean }) {
    const periodEnd = params?.periodEnd ?? new Date();
    const periodStart = params?.periodStart ?? new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
    const force = params?.force ?? false;

    if (!force) {
      // Check for existing digest with the same period
      const existing = await prisma.blogEditorialDigest.findFirst({
        where: {
          periodStart,
          periodEnd,
        },
      });

      if (existing) {
        logger.info({ type: 'blog_digest_existing_found', id: existing.id });
        return existing;
      }
    }

    try {
      // 1. Source Monitors Checked
      const sourceMonitorsChecked = await prisma.blogSourceMonitor.count();

      // 2. Source Items Discovered in period
      const sourceItemsDiscovered = await prisma.blogSourceItem.count({
        where: {
          createdAt: {
            gte: periodStart,
            lte: periodEnd,
          },
        },
      });

      // 3. High Priority & Urgent Suggestions
      const suggestions = await prisma.blogArticleSuggestion.findMany({
        where: {
          createdAt: {
            gte: periodStart,
            lte: periodEnd,
          },
        },
        select: { priority: true },
      });

      const highPrioritySuggestions = suggestions.filter((s: any) => s.priority === 'HIGH').length;
      const urgentSuggestions = suggestions.filter((s: any) => s.priority === 'URGENT').length;

      // 4. Approved Suggestions Awaiting Draft
      const approvedAwaitingDraft = await prisma.blogArticleSuggestion.count({
        where: {
          status: 'APPROVED_FOR_DRAFT',
          blogPostId: null, // no draft created yet
        },
      });

      // 5. Drafts Awaiting Verification
      const draftsAwaitingVerification = await prisma.blogPost.count({
        where: {
          status: 'DRAFT',
        },
      });

      // 6. Blocked Drafts
      const blockedDrafts = await prisma.blogPost.count({
        where: {
          status: 'IN_REVIEW',
        },
      });

      // 7. Failing Monitors
      const failingMonitors = await prisma.blogSourceMonitor.count({
        where: {
          status: 'FAILING',
        },
      });

      const digest = await prisma.blogEditorialDigest.create({
        data: {
          periodStart,
          periodEnd,
          status: 'GENERATED',
          sourceMonitorsChecked,
          sourceItemsDiscovered,
          highPrioritySuggestions,
          urgentSuggestions,
          approvedAwaitingDraft,
          draftsAwaitingVerification,
          blockedDrafts,
          failingMonitors,
          summaryJson: {
            message: `Digest generated for period ${periodStart.toISOString()} to ${periodEnd.toISOString()}`
          }
        },
      });

      logger.info({ type: 'blog_digest_generated', id: digest.id });
      return digest;
    } catch (error) {
      logger.error({ type: 'blog_digest_generation_failed', error: (error as Error).message });
      throw error;
    }
  }

  async getDigests(page: number = 1, limit: number = 10) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      prisma.blogEditorialDigest.findMany({
        orderBy: { periodEnd: 'desc' },
        skip,
        take: limit,
      }),
      prisma.blogEditorialDigest.count(),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getDigestById(id: string) {
    const digest = await prisma.blogEditorialDigest.findUnique({
      where: { id },
    });
    if (!digest) throw new Error('Digest not found');
    return digest;
  }
}

export const blogEditorialDigestService = new BlogEditorialDigestService();
