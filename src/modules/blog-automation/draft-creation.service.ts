import { TRPCError } from '@trpc/server';
import type { prisma as appPrisma } from '../../lib/prisma/client';
import { buildDraftSkeletonFromSuggestion } from './draft-skeleton.service';

type BlogAutomationPrisma = typeof appPrisma;

export interface CreateBlogDraftFromSuggestionParams {
  prisma: BlogAutomationPrisma;
  suggestionId: string;
  createdById: string;
}

export interface CreateBlogDraftFromSuggestionResult {
  blogPostId: string;
  slug: string;
}

/**
 * Extracted verbatim from blog-automation.router.ts's adminCreateDraftFromSuggestion
 * mutation body so both the admin-dashboard route and the agent-callable automation
 * route delegate to one transactional implementation. `createdById` replaces the
 * router's `ctx.user!.id` - callers pass either a real admin's session id or the
 * `sys-automation-orchestrator` service principal id (a real User row via
 * agentCredentialService.ensureServiceUser), both valid BlogPost.authorId FKs.
 */
export async function createBlogDraftFromSuggestion(
  params: CreateBlogDraftFromSuggestionParams,
): Promise<CreateBlogDraftFromSuggestionResult> {
  const { prisma, suggestionId, createdById } = params;

  const suggestion = await prisma.blogArticleSuggestion.findUnique({
    where: { id: suggestionId },
    include: {
      sources: {
        include: {
          sourceItem: {
            include: { monitor: true },
          },
        },
      },
    },
  });

  if (!suggestion || suggestion.deletedAt) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Suggestion not found' });
  }

  if (suggestion.status !== 'APPROVED_FOR_DRAFT') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Suggestion must be APPROVED_FOR_DRAFT' });
  }

  if (suggestion.blogPostId) {
    throw new TRPCError({ code: 'CONFLICT', message: 'A draft already exists for this suggestion' });
  }

  if (suggestion.sources.length === 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Suggestion has no attached sources' });
  }

  const baseSlug = suggestion.suggestedSlug || suggestion.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  let uniqueSlug = baseSlug;
  let counter = 1;
  while (true) {
    const existingPost = await prisma.blogPost.findUnique({ where: { slug: uniqueSlug } });
    if (!existingPost) break;
    uniqueSlug = `${baseSlug}-${counter}`;
    counter++;
  }

  const sourceTitles = suggestion.sources.map((s) => s.sourceItem.title);
  const sourceUrls = suggestion.sources.map((s) => s.sourceItem.url);

  const skeletonContent = buildDraftSkeletonFromSuggestion({
    title: suggestion.title,
    jurisdiction: suggestion.jurisdiction,
    category: suggestion.category,
    articleType: suggestion.articleType,
    summary: suggestion.summary,
    sourceTitles,
    sourceUrls,
    targetAudience: suggestion.targetAudience,
    recommendedTags: suggestion.recommendedTags,
  });

  return prisma.$transaction(async (tx) => {
    const blogPost = await tx.blogPost.create({
      data: {
        status: 'DRAFT',
        title: suggestion.title,
        slug: uniqueSlug,
        excerpt: suggestion.summary,
        content: skeletonContent,
        category: suggestion.category,
        tags: suggestion.recommendedTags,
        jurisdiction: suggestion.jurisdiction,
        seoTitle: suggestion.title,
        seoDescription: suggestion.summary ? suggestion.summary.substring(0, 160) : null,
        authorId: createdById,
        updatedById: createdById,
      },
    });

    for (const source of suggestion.sources) {
      await tx.blogPostSource.create({
        data: {
          postId: blogPost.id,
          sourceType: source.sourceItem.sourceType,
          title: source.sourceItem.title,
          publisher: source.sourceItem.publisher || source.sourceItem.monitor.name,
          url: source.sourceItem.url,
          publishedAt: source.sourceItem.publicationDate,
          accessedAt: new Date(),
          notes: `Created from source discovery item ${source.sourceItem.id}`,
        },
      });
    }

    await tx.blogArticleSuggestion.update({
      where: { id: suggestion.id },
      data: {
        status: 'DRAFT_CREATED',
        blogPostId: blogPost.id,
      },
    });

    return {
      blogPostId: blogPost.id,
      slug: blogPost.slug,
    };
  });
}
