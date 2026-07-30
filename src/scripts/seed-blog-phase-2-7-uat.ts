import 'dotenv/config';
import {
  BlogPostFeedbackValue,
  BlogPostStatus,
  BlogSourceType,
  PrismaClient,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  DEFAULT_UAT_RECORD_MARKER,
  isPreviewDatabaseClassificationAllowed,
  type AppRuntimeMode,
  type DatabaseEnvironment,
  type DatabaseUatRecordCounts,
} from '@/utils/database-identity';

const MARKER = DEFAULT_UAT_RECORD_MARKER;
const AUTHOR_ID = 'phase-2-7-uat-author';
const AUTHOR_EMAIL_LABEL = 'phase-2-7-uat-author';

const now = new Date('2026-07-30T09:00:00.000Z');
const past = new Date('2026-07-20T09:00:00.000Z');
const future = new Date('2036-07-30T09:00:00.000Z');

type SeedMode = 'seed' | 'cleanup';

export interface Phase27UatSeedOptions {
  mode: SeedMode;
  write: boolean;
}

export interface Phase27UatSeedSafety {
  runtimeMode: AppRuntimeMode;
  databaseEnvironment: DatabaseEnvironment;
}

type FixtureSource = {
  id: string;
  sourceType: BlogSourceType;
  title: string;
  publisher: string;
  url: string | null;
  publishedAt: Date;
  accessedAt: Date;
  notes?: string | null;
};

type FixturePost = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  coverImageUrl: string | null;
  category: string;
  tags: string[];
  status: BlogPostStatus;
  featured: boolean;
  jurisdiction: string;
  relatedRegulations: string[];
  seoTitle: string;
  seoDescription: string;
  publishedAt: Date | null;
  archivedAt?: Date | null;
  deletedAt?: Date | null;
  sources: FixtureSource[];
};

const sharedIntro = [
  'This is preview-only UAT content for SheriaBot Blog Phase 2.7.',
  'It is synthetic and must never be copied into production editorial records.',
].join('\n\n');

const tableMarkdown = [
  '| Check | Preview expectation |',
  '| --- | --- |',
  '| Database | Explicitly classified preview or development-UAT |',
  '| Workers | Disabled |',
  '| Email | Sandboxed or disabled |',
].join('\n');

const tocMarkdown = [
  '## What changed',
  'Preview operators verify that listing, detail, and form flows read from isolated UAT records.',
  '',
  '## Why it matters',
  'The Blog can be tested without production customer records or automation side effects.',
  '',
  '## Operator checks',
  'Keyboard navigation, responsive layout, noindex metadata, and analytics privacy are inspected in browser.',
  '',
  '## Expected outcome',
  'The phase remains blocked until operator evidence proves the isolated database and preview deployments.',
].join('\n');

const PHASE_27_UAT_POSTS: FixturePost[] = [
  {
    id: 'phase-2-7-uat-post-featured',
    slug: 'phase-2-7-uat-featured-preview-readiness',
    title: 'Phase 2.7 preview readiness for regulated teams',
    excerpt: 'Featured preview article for browser UAT of the SheriaBot Blog listing and detail pages.',
    content: `${sharedIntro}\n\n${tocMarkdown}\n\n- Uses public source rows.\n- Keeps internal source rows hidden from public article output.`,
    coverImageUrl: '/uat/blog/phase-2-7-featured.png',
    category: 'Regulatory Updates',
    tags: [MARKER, 'uat-regulatory-updates', 'uat-preview'],
    status: BlogPostStatus.PUBLISHED,
    featured: true,
    jurisdiction: 'Kenya',
    relatedRegulations: ['UAT Preview Control Register'],
    seoTitle: 'Phase 2.7 preview readiness UAT',
    seoDescription: 'Synthetic preview article used for SheriaBot Blog Phase 2.7 UAT.',
    publishedAt: past,
    sources: [
      {
        id: 'phase-2-7-uat-source-featured-public',
        sourceType: BlogSourceType.OFFICIAL,
        title: 'UAT public source record',
        publisher: 'SheriaBot UAT Source Registry',
        url: null,
        publishedAt: past,
        accessedAt: now,
      },
      {
        id: 'phase-2-7-uat-source-featured-internal',
        sourceType: BlogSourceType.INTERNAL,
        title: 'UAT internal review note',
        publisher: 'SheriaBot UAT Internal',
        url: null,
        publishedAt: past,
        accessedAt: now,
        notes: 'Internal source row for preview filtering verification only.',
      },
    ],
  },
  {
    id: 'phase-2-7-uat-post-no-cover',
    slug: 'phase-2-7-uat-no-cover-image',
    title: 'Preview article without a cover image',
    excerpt: 'Validates image fallback behavior on listing cards and article detail.',
    content: `${sharedIntro}\n\n## Fallback image\nThis record intentionally has no cover image.`,
    coverImageUrl: null,
    category: 'Compliance Ops',
    tags: [MARKER, 'uat-compliance-ops'],
    status: BlogPostStatus.PUBLISHED,
    featured: false,
    jurisdiction: 'Kenya',
    relatedRegulations: ['UAT Image Fallback'],
    seoTitle: 'Preview article without cover image',
    seoDescription: 'Synthetic UAT record for image fallback testing.',
    publishedAt: new Date('2026-07-21T09:00:00.000Z'),
    sources: [],
  },
  {
    id: 'phase-2-7-uat-post-long-title',
    slug: 'phase-2-7-uat-long-title-wrapping',
    title: 'A deliberately long SheriaBot preview headline for validating multi-line wrapping in cards search results featured slots and article metadata without overflow',
    excerpt: 'Validates long-title wrapping across desktop, tablet, and narrow mobile layouts.',
    content: `${sharedIntro}\n\n## Long title\nThe title is intentionally long to exercise responsive wrapping.`,
    coverImageUrl: '/uat/blog/phase-2-7-long-title.png',
    category: 'Regulatory Updates',
    tags: [MARKER, 'uat-regulatory-updates', 'uat-long-title'],
    status: BlogPostStatus.PUBLISHED,
    featured: false,
    jurisdiction: 'Kenya',
    relatedRegulations: ['UAT Title Wrapping'],
    seoTitle: 'Long-title UAT article',
    seoDescription: 'Synthetic UAT record for long-title responsive testing.',
    publishedAt: new Date('2026-07-22T09:00:00.000Z'),
    sources: [],
  },
  {
    id: 'phase-2-7-uat-post-toc',
    slug: 'phase-2-7-uat-table-of-contents',
    title: 'Table of contents preview article',
    excerpt: 'Contains enough headings to validate article table of contents behavior.',
    content: `${sharedIntro}\n\n${tocMarkdown}`,
    coverImageUrl: '/uat/blog/phase-2-7-toc.png',
    category: 'Compliance Ops',
    tags: [MARKER, 'uat-compliance-ops', 'uat-toc'],
    status: BlogPostStatus.PUBLISHED,
    featured: false,
    jurisdiction: 'Kenya',
    relatedRegulations: ['UAT TOC'],
    seoTitle: 'Table of contents UAT article',
    seoDescription: 'Synthetic UAT record for table of contents testing.',
    publishedAt: new Date('2026-07-23T09:00:00.000Z'),
    sources: [],
  },
  {
    id: 'phase-2-7-uat-post-table',
    slug: 'phase-2-7-uat-responsive-table',
    title: 'Responsive table preview article',
    excerpt: 'Contains a markdown table to validate horizontal table handling on mobile.',
    content: `${sharedIntro}\n\n## Responsive table\n${tableMarkdown}`,
    coverImageUrl: '/uat/blog/phase-2-7-table.png',
    category: 'Regulatory Updates',
    tags: [MARKER, 'uat-regulatory-updates', 'uat-table'],
    status: BlogPostStatus.PUBLISHED,
    featured: false,
    jurisdiction: 'Kenya',
    relatedRegulations: ['UAT Table'],
    seoTitle: 'Responsive table UAT article',
    seoDescription: 'Synthetic UAT record for table rendering testing.',
    publishedAt: new Date('2026-07-24T09:00:00.000Z'),
    sources: [],
  },
  {
    id: 'phase-2-7-uat-post-related-a',
    slug: 'phase-2-7-uat-related-content-a',
    title: 'Related content preview article A',
    excerpt: 'Supports related-article UAT by sharing category and tags with another UAT post.',
    content: `${sharedIntro}\n\n## Related content\nThis record should appear as related content where matching rules apply.`,
    coverImageUrl: '/uat/blog/phase-2-7-related-a.png',
    category: 'Compliance Ops',
    tags: [MARKER, 'uat-compliance-ops', 'uat-related'],
    status: BlogPostStatus.PUBLISHED,
    featured: false,
    jurisdiction: 'Kenya',
    relatedRegulations: ['UAT Related Content'],
    seoTitle: 'Related content UAT article A',
    seoDescription: 'Synthetic UAT record for related content testing.',
    publishedAt: new Date('2026-07-25T09:00:00.000Z'),
    sources: [],
  },
  {
    id: 'phase-2-7-uat-post-related-b',
    slug: 'phase-2-7-uat-related-content-b',
    title: 'Related content preview article B',
    excerpt: 'Second published related-content record for exclusion and placement checks.',
    content: `${sharedIntro}\n\n## Related content\nThe current article must not include itself in related items.`,
    coverImageUrl: '/uat/blog/phase-2-7-related-b.png',
    category: 'Compliance Ops',
    tags: [MARKER, 'uat-compliance-ops', 'uat-related'],
    status: BlogPostStatus.PUBLISHED,
    featured: false,
    jurisdiction: 'Kenya',
    relatedRegulations: ['UAT Related Content'],
    seoTitle: 'Related content UAT article B',
    seoDescription: 'Synthetic UAT record for related content exclusion testing.',
    publishedAt: new Date('2026-07-26T09:00:00.000Z'),
    sources: [],
  },
  {
    id: 'phase-2-7-uat-post-draft',
    slug: 'phase-2-7-uat-draft-hidden',
    title: 'Draft preview article hidden from public procedures',
    excerpt: 'Non-public draft UAT record.',
    content: `${sharedIntro}\n\n## Draft\nThis record must return 404 through public article procedures.`,
    coverImageUrl: null,
    category: 'Regulatory Updates',
    tags: [MARKER, 'uat-hidden'],
    status: BlogPostStatus.DRAFT,
    featured: false,
    jurisdiction: 'Kenya',
    relatedRegulations: ['UAT Hidden Records'],
    seoTitle: 'Draft hidden UAT article',
    seoDescription: 'Synthetic draft UAT record.',
    publishedAt: null,
    sources: [],
  },
  {
    id: 'phase-2-7-uat-post-future',
    slug: 'phase-2-7-uat-future-hidden',
    title: 'Future-dated preview article hidden until publication time',
    excerpt: 'Non-public future-dated UAT record.',
    content: `${sharedIntro}\n\n## Future dated\nThis record must not appear before its publication timestamp.`,
    coverImageUrl: null,
    category: 'Compliance Ops',
    tags: [MARKER, 'uat-hidden'],
    status: BlogPostStatus.PUBLISHED,
    featured: false,
    jurisdiction: 'Kenya',
    relatedRegulations: ['UAT Hidden Records'],
    seoTitle: 'Future hidden UAT article',
    seoDescription: 'Synthetic future-dated UAT record.',
    publishedAt: future,
    sources: [],
  },
  {
    id: 'phase-2-7-uat-post-archived',
    slug: 'phase-2-7-uat-archived-hidden',
    title: 'Archived preview article hidden from public procedures',
    excerpt: 'Non-public archived UAT record.',
    content: `${sharedIntro}\n\n## Archived\nThis record must return 404 through public article procedures.`,
    coverImageUrl: null,
    category: 'Regulatory Updates',
    tags: [MARKER, 'uat-hidden'],
    status: BlogPostStatus.ARCHIVED,
    featured: false,
    jurisdiction: 'Kenya',
    relatedRegulations: ['UAT Hidden Records'],
    seoTitle: 'Archived hidden UAT article',
    seoDescription: 'Synthetic archived UAT record.',
    publishedAt: past,
    archivedAt: now,
    sources: [],
  },
  {
    id: 'phase-2-7-uat-post-deleted',
    slug: 'phase-2-7-uat-soft-deleted-hidden',
    title: 'Soft-deleted preview article hidden from public procedures',
    excerpt: 'Non-public soft-deleted UAT record.',
    content: `${sharedIntro}\n\n## Soft deleted\nThis record must return 404 through public article procedures.`,
    coverImageUrl: null,
    category: 'Compliance Ops',
    tags: [MARKER, 'uat-hidden'],
    status: BlogPostStatus.PUBLISHED,
    featured: false,
    jurisdiction: 'Kenya',
    relatedRegulations: ['UAT Hidden Records'],
    seoTitle: 'Soft-deleted hidden UAT article',
    seoDescription: 'Synthetic soft-deleted UAT record.',
    publishedAt: past,
    deletedAt: now,
    sources: [],
  },
];

const FEEDBACK_FIXTURES = [
  {
    id: 'phase-2-7-uat-feedback-helpful',
    blogPostId: 'phase-2-7-uat-post-featured',
    value: BlogPostFeedbackValue.HELPFUL,
    anonymousKeyHash: 'phase-2-7-uat-feedback-reader-a',
  },
  {
    id: 'phase-2-7-uat-feedback-not-helpful',
    blogPostId: 'phase-2-7-uat-post-table',
    value: BlogPostFeedbackValue.NOT_HELPFUL,
    anonymousKeyHash: 'phase-2-7-uat-feedback-reader-b',
  },
];

const TOPIC_REQUEST_FIXTURES = [
  {
    id: 'phase-2-7-uat-topic-request-basic',
    topic: 'Phase 2.7 UAT request for a compliance checklist article',
    category: MARKER,
    jurisdiction: 'Kenya',
    sourcePage: MARKER,
    anonymousKeyHash: 'phase-2-7-uat-topic-reader-a',
  },
  {
    id: 'phase-2-7-uat-topic-request-category',
    topic: 'Phase 2.7 UAT request for a regulatory update explainer',
    category: MARKER,
    jurisdiction: 'Kenya',
    sourcePage: MARKER,
    anonymousKeyHash: 'phase-2-7-uat-topic-reader-b',
  },
  {
    id: 'phase-2-7-uat-topic-request-optional-email',
    topic: 'Phase 2.7 UAT request with optional contact deliberately omitted',
    category: MARKER,
    jurisdiction: 'Kenya',
    sourcePage: MARKER,
    anonymousKeyHash: 'phase-2-7-uat-topic-reader-c',
  },
];

export const PHASE_27_UAT_EXPECTED_COUNTS: DatabaseUatRecordCounts = {
  blogPosts: PHASE_27_UAT_POSTS.length,
  publishedBlogPosts: PHASE_27_UAT_POSTS.filter((post) => (
    post.status === BlogPostStatus.PUBLISHED
      && post.deletedAt == null
      && post.publishedAt != null
      && post.publishedAt <= now
  )).length,
  draftBlogPosts: PHASE_27_UAT_POSTS.filter((post) => post.status === BlogPostStatus.DRAFT && post.deletedAt == null).length,
  archivedBlogPosts: PHASE_27_UAT_POSTS.filter((post) => post.status === BlogPostStatus.ARCHIVED && post.deletedAt == null).length,
  futureDatedPublishedBlogPosts: PHASE_27_UAT_POSTS.filter((post) => (
    post.status === BlogPostStatus.PUBLISHED
      && post.deletedAt == null
      && post.publishedAt != null
      && post.publishedAt > now
  )).length,
  softDeletedBlogPosts: PHASE_27_UAT_POSTS.filter((post) => post.deletedAt != null).length,
  feedbackRows: FEEDBACK_FIXTURES.length,
  topicRequestRows: TOPIC_REQUEST_FIXTURES.length,
};

const DATABASE_ENVIRONMENTS: readonly DatabaseEnvironment[] = [
  'unknown',
  'preview',
  'development-uat',
  'production',
];

function parseRuntimeMode(value: string | undefined): AppRuntimeMode {
  return value === 'preview' ? 'preview' : 'standard';
}

function parseDatabaseEnvironment(value: string | undefined): DatabaseEnvironment {
  const normalized = value?.trim().toLowerCase();
  return DATABASE_ENVIRONMENTS.includes(normalized as DatabaseEnvironment)
    ? (normalized as DatabaseEnvironment)
    : 'unknown';
}

export function assertPhase27UatSeedSafety(env: NodeJS.ProcessEnv): Phase27UatSeedSafety {
  const runtimeMode = parseRuntimeMode(env.APP_RUNTIME_MODE);
  const databaseEnvironment = parseDatabaseEnvironment(env.DATABASE_ENVIRONMENT);

  if (runtimeMode !== 'preview') {
    throw new Error('Phase 2.7 UAT seed blocked: APP_RUNTIME_MODE must be preview.');
  }

  if (!isPreviewDatabaseClassificationAllowed(databaseEnvironment)) {
    throw new Error('Phase 2.7 UAT seed blocked: DATABASE_ENVIRONMENT must be preview or development-uat.');
  }

  return { runtimeMode, databaseEnvironment };
}

export function parsePhase27UatSeedOptions(argv: string[]): Phase27UatSeedOptions {
  return {
    mode: argv.includes('--cleanup') ? 'cleanup' : 'seed',
    write: argv.includes('--write'),
  };
}

function basePostData(post: FixturePost) {
  return {
    title: post.title,
    excerpt: post.excerpt,
    content: post.content,
    htmlContent: null,
    coverImageUrl: post.coverImageUrl,
    category: post.category,
    tags: post.tags,
    status: post.status,
    featured: post.featured,
    jurisdiction: post.jurisdiction,
    relatedRegulations: post.relatedRegulations,
    seoTitle: post.seoTitle,
    seoDescription: post.seoDescription,
    canonicalUrl: null,
    ogImageUrl: null,
    authorId: AUTHOR_ID,
    reviewerId: null,
    updatedById: AUTHOR_ID,
    publishedAt: post.publishedAt,
    lastReviewedAt: now,
    archivedAt: post.archivedAt ?? null,
    deletedAt: post.deletedAt ?? null,
  };
}

function sourceCreateData(source: FixtureSource) {
  return {
    id: source.id,
    sourceType: source.sourceType,
    title: source.title,
    publisher: source.publisher,
    url: source.url,
    publishedAt: source.publishedAt,
    accessedAt: source.accessedAt,
    notes: source.notes ?? null,
  };
}

async function ensureUatAuthor(prisma: PrismaClient): Promise<void> {
  await prisma.user.upsert({
    where: { id: AUTHOR_ID },
    update: {
      email: AUTHOR_EMAIL_LABEL,
      fullName: 'SheriaBot Phase 2.7 UAT Author',
      role: UserRole.SERVICE,
      status: UserStatus.ACTIVE,
      accountStatus: 'active',
      emailVerified: true,
      preferences: { uatMarker: MARKER },
    },
    create: {
      id: AUTHOR_ID,
      email: AUTHOR_EMAIL_LABEL,
      fullName: 'SheriaBot Phase 2.7 UAT Author',
      role: UserRole.SERVICE,
      status: UserStatus.ACTIVE,
      accountStatus: 'active',
      emailVerified: true,
      preferences: { uatMarker: MARKER },
    },
  });
}

async function seedPosts(prisma: PrismaClient): Promise<void> {
  for (const post of PHASE_27_UAT_POSTS) {
    const data = basePostData(post);
    await prisma.blogPost.upsert({
      where: { slug: post.slug },
      update: {
        ...data,
        sources: {
          deleteMany: {},
          create: post.sources.map(sourceCreateData),
        },
      },
      create: {
        id: post.id,
        slug: post.slug,
        ...data,
        sources: {
          create: post.sources.map(sourceCreateData),
        },
      },
    });
  }
}

async function seedFeedbackAndTopicRequests(prisma: PrismaClient): Promise<void> {
  for (const feedback of FEEDBACK_FIXTURES) {
    await prisma.blogPostFeedback.upsert({
      where: { id: feedback.id },
      update: {
        blogPostId: feedback.blogPostId,
        value: feedback.value,
        anonymousKeyHash: feedback.anonymousKeyHash,
        userId: null,
      },
      create: {
        ...feedback,
        userId: null,
      },
    });
  }

  for (const request of TOPIC_REQUEST_FIXTURES) {
    await prisma.blogTopicRequest.upsert({
      where: { id: request.id },
      update: {
        topic: request.topic,
        category: request.category,
        jurisdiction: request.jurisdiction,
        sourcePage: request.sourcePage,
        contactEmail: null,
        anonymousKeyHash: request.anonymousKeyHash,
      },
      create: {
        ...request,
        contactEmail: null,
      },
    });
  }
}

async function cleanupFixture(prisma: PrismaClient): Promise<void> {
  const posts = await prisma.blogPost.findMany({
    where: { tags: { has: MARKER } },
    select: { id: true },
  });
  const postIds = posts.map((post) => post.id);

  await prisma.blogTopicRequest.deleteMany({
    where: {
      OR: [
        { category: MARKER },
        { sourcePage: MARKER },
      ],
    },
  });

  if (postIds.length > 0) {
    await prisma.blogPostFeedback.deleteMany({ where: { blogPostId: { in: postIds } } });
    await prisma.blogPostSource.deleteMany({ where: { postId: { in: postIds } } });
    await prisma.blogPost.deleteMany({ where: { id: { in: postIds } } });
  }

  await prisma.user.deleteMany({ where: { id: AUTHOR_ID } });
}

export function createPhase27UatSeedSummary(options: Phase27UatSeedOptions) {
  return {
    marker: MARKER,
    mode: options.mode,
    write: options.write,
    expectedIdentityCounts: PHASE_27_UAT_EXPECTED_COUNTS,
    fixtureShape: {
      posts: PHASE_27_UAT_POSTS.length,
      categories: Array.from(new Set(PHASE_27_UAT_POSTS.map((post) => post.category))).length,
      tags: Array.from(new Set(PHASE_27_UAT_POSTS.flatMap((post) => post.tags))).length,
      publicSourceRows: PHASE_27_UAT_POSTS.flatMap((post) => post.sources).filter((source) => source.sourceType !== BlogSourceType.INTERNAL).length,
      internalSourceRows: PHASE_27_UAT_POSTS.flatMap((post) => post.sources).filter((source) => source.sourceType === BlogSourceType.INTERNAL).length,
    },
  };
}

async function main(): Promise<void> {
  const options = parsePhase27UatSeedOptions(process.argv.slice(2));
  const safety = assertPhase27UatSeedSafety(process.env);
  const summary = {
    ...createPhase27UatSeedSummary(options),
    runtimeMode: safety.runtimeMode,
    databaseEnvironment: safety.databaseEnvironment,
  };

  if (!options.write) {
    console.log(JSON.stringify({
      ...summary,
      result: 'dry-run',
    }, null, 2));
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('Phase 2.7 UAT seed blocked: DATABASE_URL is required for preview write mode.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    if (options.mode === 'cleanup') {
      await cleanupFixture(prisma);
    } else {
      await ensureUatAuthor(prisma);
      await seedPosts(prisma);
      await seedFeedbackAndTopicRequests(prisma);
    }

    console.log(JSON.stringify({
      ...summary,
      result: options.mode === 'cleanup' ? 'cleanup-complete' : 'seed-complete',
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Phase 2.7 UAT seed failed.';
    console.error(message);
    process.exitCode = 1;
  });
}
