import { BlogSourceItemStatus, BlogSuggestionStatus } from '@prisma/client';
import type { prisma as appPrisma } from '@/lib/prisma/client';
import { appConfig } from '@/config/app.config';
import { scoreSourceItemForBlogSuggestion } from './relevance-scoring.service';
import { blogNotificationService } from './blog-notification.service';
import { computeRequiresHumanReviewAtCreation } from './human-review-policy';

type BlogAutomationPrisma = typeof appPrisma;

export async function createSuggestionFromSourceItem(params: {
  prisma: BlogAutomationPrisma;
  sourceItemId: string;
  minScore?: number;
  createdByUserId?: string;
}) {
  const { prisma, sourceItemId, minScore = 45, createdByUserId } = params;

  const sourceItem = await prisma.blogSourceItem.findUnique({
    where: { id: sourceItemId },
    include: { monitor: true },
  });

  if (!sourceItem) {
    throw new Error('Source item not found');
  }

  // Reject deleted, dismissed, duplicate, converted, or failed
  if (sourceItem.deletedAt) throw new Error('Source item is deleted');
  const invalidStatuses: BlogSourceItemStatus[] = [
    'DISMISSED',
    'DUPLICATE',
    'CONVERTED_TO_SUGGESTION',
    'FETCH_FAILED',
  ];
  if (invalidStatuses.includes(sourceItem.status)) {
    throw new Error(`Source item cannot be scored from status: ${sourceItem.status}`);
  }

  const scoringResult = scoreSourceItemForBlogSuggestion(sourceItem as any);

  if (scoringResult.relevanceScore < minScore) {
    // Update status to SCORED but do not create suggestion
    await prisma.blogSourceItem.update({
      where: { id: sourceItemId },
      data: { status: 'SCORED' },
    });
    return { createdSuggestion: false, scoringResult, suggestion: null };
  }

  // Check if suggestion already exists
  const existingLink = await prisma.blogSuggestionSource.findFirst({
    where: { sourceItemId },
  });

  if (existingLink) {
    // Already converted
    await prisma.blogSourceItem.update({
      where: { id: sourceItemId },
      data: { status: 'CONVERTED_TO_SUGGESTION' },
    });
    return { createdSuggestion: false, scoringResult, suggestion: null, reason: 'Duplicate' };
  }

  // Create suggestion
  const suggestion = await prisma.$transaction(async (tx) => {
    // Pack 1 Foundation E (corrected): compute and persist an EXPLICIT
    // requiresHumanReview value rather than silently inheriting the Prisma
    // column default (`true`). Gated behind the policy flag so it can be
    // deployed without changing behavior until an operator explicitly turns
    // it on - see docs/editorial-intelligence/human-review-backfill-runbook.md.
    // When the flag is off, the field is omitted from `data` entirely,
    // preserving today's default-only behavior exactly.
    const humanReviewData = appConfig.editorial.humanReviewPolicyEnabled
      ? {
          requiresHumanReview: computeRequiresHumanReviewAtCreation({
            category: scoringResult.category,
            requiresOfficialSource: scoringResult.requiresOfficialSource,
            sourceQuality: scoringResult.sourceQuality,
            priority: scoringResult.priority,
            jurisdiction: sourceItem.jurisdiction,
          }).required,
        }
      : {};

    const sug = await tx.blogArticleSuggestion.create({
      data: {
        title: scoringResult.recommendedTitle,
        suggestedSlug: scoringResult.suggestedSlug,
        summary: sourceItem.summary,
        jurisdiction: sourceItem.jurisdiction,
        jurisdictions: [sourceItem.jurisdiction],
        category: scoringResult.category,
        articleType: scoringResult.articleType,
        priority: scoringResult.priority,
        status: BlogSuggestionStatus.PENDING_REVIEW,
        relevanceScore: scoringResult.relevanceScore,
        sourceQuality: scoringResult.sourceQuality,
        recommendedTags: scoringResult.recommendedTags,
        targetAudience: scoringResult.targetAudience,
        reason: scoringResult.reason,
        suggestedNextAction: scoringResult.suggestedNextAction,
        requiresOfficialSource: scoringResult.requiresOfficialSource,
        needsMoreSources: scoringResult.needsMoreSources,
        ...humanReviewData,
      },
    });

    await tx.blogSuggestionSource.create({
      data: {
        suggestionId: sug.id,
        sourceItemId: sourceItem.id,
      },
    });

    await tx.blogSourceItem.update({
      where: { id: sourceItemId },
      data: { status: 'CONVERTED_TO_SUGGESTION' },
    });

    return sug;
  });

  if (suggestion.priority === 'HIGH' || suggestion.priority === 'URGENT') {
    const adminId = createdByUserId || sourceItem.monitor.createdById;
    if (adminId) {
      await blogNotificationService.notifyHighPrioritySuggestion(
        adminId,
        sourceItem.monitor.name,
        suggestion.id
      ).catch(console.error);
    }
  }

  return { createdSuggestion: true, scoringResult, suggestion };
}
