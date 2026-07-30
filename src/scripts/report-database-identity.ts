import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  collectSafeDatabaseIdentityReport,
  createUnqueriedDatabaseIdentityReport,
  type AppRuntimeMode,
  type DatabaseEnvironment,
  type DatabaseIdentityQueryRunner,
  type DatabaseUatRecordCounts,
  isPreviewDatabaseClassificationAllowed,
} from '@/utils/database-identity';

type CountRow = { count: number | bigint };
type NameRow = { database_name: string };

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

function toNumber(value: number | bigint | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  return value ?? 0;
}

class PrismaDatabaseIdentityQueryRunner implements DatabaseIdentityQueryRunner {
  constructor(private readonly prisma: PrismaClient) {}

  async getDatabaseName(): Promise<string> {
    const rows = await this.prisma.$queryRaw<NameRow[]>`
      SELECT current_database() AS database_name
    `;
    return rows[0]?.database_name ?? 'unknown';
  }

  async getMigrationCount(): Promise<number> {
    const rows = await this.prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*)::int AS count
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL
    `;
    return toNumber(rows[0]?.count);
  }

  async getUatRecordCounts(marker: string): Promise<DatabaseUatRecordCounts> {
    const [
      blogPosts,
      publishedBlogPosts,
      draftBlogPosts,
      archivedBlogPosts,
      futureDatedPublishedBlogPosts,
      softDeletedBlogPosts,
      feedbackRows,
      topicRequestRows,
    ] = await Promise.all([
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::int AS count
        FROM "BlogPost"
        WHERE ${marker} = ANY("tags")
      `,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::int AS count
        FROM "BlogPost"
        WHERE ${marker} = ANY("tags")
          AND "status" = 'PUBLISHED'
          AND "deletedAt" IS NULL
          AND "publishedAt" IS NOT NULL
          AND "publishedAt" <= NOW()
      `,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::int AS count
        FROM "BlogPost"
        WHERE ${marker} = ANY("tags")
          AND "status" = 'DRAFT'
          AND "deletedAt" IS NULL
      `,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::int AS count
        FROM "BlogPost"
        WHERE ${marker} = ANY("tags")
          AND "status" = 'ARCHIVED'
          AND "deletedAt" IS NULL
      `,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::int AS count
        FROM "BlogPost"
        WHERE ${marker} = ANY("tags")
          AND "status" = 'PUBLISHED'
          AND "publishedAt" > NOW()
          AND "deletedAt" IS NULL
      `,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::int AS count
        FROM "BlogPost"
        WHERE ${marker} = ANY("tags")
          AND "deletedAt" IS NOT NULL
      `,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::int AS count
        FROM "BlogPostFeedback" feedback
        JOIN "BlogPost" post ON post.id = feedback."blogPostId"
        WHERE ${marker} = ANY(post."tags")
      `,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::int AS count
        FROM "BlogTopicRequest"
        WHERE category = ${marker}
           OR "sourcePage" = ${marker}
      `,
    ]);

    return {
      blogPosts: toNumber(blogPosts[0]?.count),
      publishedBlogPosts: toNumber(publishedBlogPosts[0]?.count),
      draftBlogPosts: toNumber(draftBlogPosts[0]?.count),
      archivedBlogPosts: toNumber(archivedBlogPosts[0]?.count),
      futureDatedPublishedBlogPosts: toNumber(futureDatedPublishedBlogPosts[0]?.count),
      softDeletedBlogPosts: toNumber(softDeletedBlogPosts[0]?.count),
      feedbackRows: toNumber(feedbackRows[0]?.count),
      topicRequestRows: toNumber(topicRequestRows[0]?.count),
    };
  }
}

async function main(): Promise<void> {
  const runtimeMode = parseRuntimeMode(process.env.APP_RUNTIME_MODE);
  const databaseEnvironment = parseDatabaseEnvironment(process.env.DATABASE_ENVIRONMENT);
  const applicationEnvironment = process.env.NODE_ENV ?? 'development';

  if (!isPreviewDatabaseClassificationAllowed(databaseEnvironment)) {
    console.log(JSON.stringify(createUnqueriedDatabaseIdentityReport({
      applicationEnvironment,
      runtimeMode,
      databaseEnvironment,
    }), null, 2));
    process.exit(runtimeMode === 'preview' ? 2 : 0);
  }

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required for classified preview database identity checks.');
    process.exit(1);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const report = await collectSafeDatabaseIdentityReport({
      applicationEnvironment,
      runtimeMode,
      databaseEnvironment,
      queryRunner: new PrismaDatabaseIdentityQueryRunner(prisma),
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Database identity check failed.';
  console.error(message);
  process.exit(1);
});
