import { PrismaClient, BlogSourceItemStatus, BlogSuggestionStatus } from '@prisma/client';
import { scoreSourceItemForBlogSuggestion } from './relevance-scoring.service';

const prisma = new PrismaClient();

export async function createSuggestionFromSourceItem({
  sourceItemId,
  minScore = 45,
}: {
  sourceItemId: string;
  minScore?: number;
  createdByUserId?: string;
}) {
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

  return { createdSuggestion: true, scoringResult, suggestion };
}
