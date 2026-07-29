import { prisma } from '@/lib/prisma/client';
import { computeBlogPublicationSnapshot, parseBlogPublicationSnapshot } from '@/modules/blog-automation/publication-snapshot';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getStringMetadata(metadata: unknown, field: string): string | null {
  if (!isRecord(metadata)) return null;
  const value = metadata[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function main() {
  const now = new Date();

  const [
    legacyBlogPostTotal,
    legacyBlogPostStatuses,
    legacyBlogPostsPreviouslyPublic,
    futurePublishedBlogPosts,
    publishedBlogPostsWithNullPublishedAt,
    suspiciousBlogPostSlugs,
    suspiciousLegacyContentSlugs,
    publicationApprovals,
  ] = await Promise.all([
    prisma.legalDocument.count({ where: { contentType: 'BLOG_POST' } }),
    prisma.legalDocument.groupBy({
      by: ['contentStatus'],
      where: { contentType: 'BLOG_POST' },
      _count: { _all: true },
    }),
    prisma.legalDocument.count({
      where: {
        contentType: 'BLOG_POST',
        contentStatus: 'PUBLISHED',
        deletedAt: null,
        slug: { not: null },
        OR: [{ publishedAt: null }, { publishedAt: { lte: now } }],
      },
    }),
    prisma.blogPost.count({
      where: {
        status: 'PUBLISHED',
        deletedAt: null,
        publishedAt: { gt: now },
      },
    }),
    prisma.blogPost.count({
      where: {
        status: 'PUBLISHED',
        deletedAt: null,
        publishedAt: null,
      },
    }),
    prisma.blogPost.count({
      where: {
        OR: [{ slug: '' }, { slug: { contains: ' ' } }],
      },
    }),
    prisma.legalDocument.count({
      where: {
        OR: [{ slug: '' }, { slug: { contains: ' ' } }],
      },
    }),
    prisma.automationApproval.findMany({
      where: {
        department: 'CONTENT',
        workflow: 'W-CONTENT-02',
        kind: 'BLOG_POST_PUBLICATION',
      },
      select: {
        id: true,
        status: true,
        metadata: true,
      },
    }),
  ]);

  let approvalsMissingSnapshotMetadata = 0;
  let approvedButUnpublishedPosts = 0;
  let publishedAutomationPostsWithUnverifiedSnapshot = 0;

  for (const approval of publicationApprovals) {
    const snapshot = isRecord(approval.metadata) ? parseBlogPublicationSnapshot(approval.metadata.publicationSnapshot) : null;
    if (!snapshot) approvalsMissingSnapshotMetadata++;

    const blogPostId = getStringMetadata(approval.metadata, 'blogPostId');
    if (!blogPostId) continue;

    const post = await prisma.blogPost.findUnique({
      where: { id: blogPostId },
      include: {
        sources: true,
        draftGenerationRuns: { orderBy: { createdAt: 'desc' }, take: 1 },
        verificationRuns: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!post) continue;

    if (approval.status === 'approved' && post.status !== 'PUBLISHED') {
      approvedButUnpublishedPosts++;
    }

    if (approval.status === 'approved' && post.status === 'PUBLISHED') {
      if (!snapshot) {
        publishedAutomationPostsWithUnverifiedSnapshot++;
      } else {
        const currentSnapshot = computeBlogPublicationSnapshot(post, now);
        if (
          currentSnapshot.contentHash !== snapshot.contentHash ||
          currentSnapshot.sourceSetHash !== snapshot.sourceSetHash ||
          currentSnapshot.publicationPayloadHash !== snapshot.publicationPayloadHash ||
          currentSnapshot.draftGenerationRunId !== snapshot.draftGenerationRunId ||
          currentSnapshot.verificationRunId !== snapshot.verificationRunId
        ) {
          publishedAutomationPostsWithUnverifiedSnapshot++;
        }
      }
    }
  }

  console.log(JSON.stringify({
    generatedAt: now.toISOString(),
    legacyLegalDocumentBlogPosts: {
      total: legacyBlogPostTotal,
      byStatus: Object.fromEntries(legacyBlogPostStatuses.map((row) => [row.contentStatus, row._count._all])),
      previouslyPublicByLegacySlugRule: legacyBlogPostsPreviouslyPublic,
    },
    canonicalBlogPosts: {
      futureDatedPublished: futurePublishedBlogPosts,
      publishedWithNullPublishedAt: publishedBlogPostsWithNullPublishedAt,
      suspiciousSlugCount: suspiciousBlogPostSlugs,
    },
    legacyContent: {
      suspiciousSlugCount: suspiciousLegacyContentSlugs,
    },
    automationPublicationApprovals: {
      total: publicationApprovals.length,
      missingSnapshotMetadata: approvalsMissingSnapshotMetadata,
      approvedButUnpublishedPosts,
      publishedAutomationPostsWithUnverifiedSnapshot,
    },
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(`Phase 0 Blog data assessment failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
