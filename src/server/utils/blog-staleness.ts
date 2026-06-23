import { BlogPost, BlogDraftGenerationRun, BlogVerificationRun, BlogPostSource } from '@prisma/client';

type BlogPostWithRelations = BlogPost & {
  sources: BlogPostSource[];
  draftGenerationRuns: BlogDraftGenerationRun[];
  verificationRuns: BlogVerificationRun[];
};

export function calculateBlogStaleness(post: BlogPostWithRelations) {
  const latestVerification = post.verificationRuns[0];

  if (!latestVerification || !latestVerification.completedAt) {
    return {
      isStale: false,
      isAiStale: false,
    };
  }

  const verifiedAt = latestVerification.completedAt;

  // Manual staleness: Were there any updates to the post or its sources after verification?
  let isStale = post.updatedAt > verifiedAt;
  if (!isStale && post.sources) {
    isStale = post.sources.some(source => source.updatedAt > verifiedAt);
  }

  // AI staleness: Was a new AI draft applied after verification?
  let isAiStale = false;
  if (post.draftGenerationRuns) {
    const latestAppliedRun = post.draftGenerationRuns.find(run => run.appliedToPost && run.appliedAt);
    if (latestAppliedRun && latestAppliedRun.appliedAt && latestAppliedRun.appliedAt > verifiedAt) {
      isAiStale = true;
    }
  }

  return {
    isStale,
    isAiStale,
  };
}
