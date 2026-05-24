import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';

type DauRange = 'last7d' | 'last30d' | 'last90d';
type QpuRange = 'last7d' | 'last30d' | 'alltime';
type FeedbackRange = 'last7d' | 'last30d' | 'last90d';

const RANGE_DAYS: Record<'last7d' | 'last30d' | 'last90d', number> = {
  last7d: 7,
  last30d: 30,
  last90d: 90,
};

const NBO_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Nairobi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

class AnalyticsAdminService {
  private getNairobiToday(): string {
    return NBO_FMT.format(new Date());
  }

  private buildNairobiDateRange(daysBack: number): string[] {
    const dates: string[] = [];
    for (let i = daysBack - 1; i >= 0; i--) {
      dates.push(NBO_FMT.format(new Date(Date.now() - i * 86_400_000)));
    }
    return dates;
  }

  async getDailyActiveUsers(input: { range: DauRange }): Promise<{
    today: number;
    series: Array<{ date: string; dau: number }>;
  }> {
    const startMs = Date.now();
    const daysBack = RANGE_DAYS[input.range];
    const todayNbo = this.getNairobiToday();
    const expectedDates = this.buildNairobiDateRange(daysBack);

    // Batch-read all date keys
    const cachedValues = await Promise.all(
      expectedDates.map(d => redis.get<string>(`sheriabot:analytics:dau:nbo:${d}`)),
    );

    const cachedMap = new Map<string, number>();
    const missingDates: string[] = [];

    cachedValues.forEach((val, i) => {
      if (val !== null) {
        cachedMap.set(expectedDates[i], JSON.parse(val) as number);
      } else {
        missingDates.push(expectedDates[i]);
      }
    });

    if (missingDates.length > 0) {
      const rangeStart = new Date(Date.now() - daysBack * 86_400_000);

      const rows = await prisma.$queryRaw<Array<{ date: string; dau: bigint }>>`
        SELECT
          ("createdAt" AT TIME ZONE 'Africa/Nairobi')::date::text AS date,
          COUNT(DISTINCT "userId") AS dau
        FROM "ComplianceQuery"
        WHERE "createdAt" >= ${rangeStart}
        GROUP BY 1
        ORDER BY 1 ASC
      `;

      const queryMap = new Map(rows.map(r => [r.date, Number(r.dau)]));

      const pipeline = redis.pipeline();
      for (const d of missingDates) {
        const dau = queryMap.get(d) ?? 0;
        cachedMap.set(d, dau);
        const ttl = d === todayNbo ? 300 : 86400;
        pipeline.set(`sheriabot:analytics:dau:nbo:${d}`, JSON.stringify(dau), { ex: ttl });
      }
      await pipeline.exec();
    }

    const series = expectedDates.map(d => ({ date: d, dau: cachedMap.get(d) ?? 0 }));
    const today = cachedMap.get(todayNbo) ?? 0;

    logger.info({
      type: 'analytics_dau_query',
      range: input.range,
      cacheHits: expectedDates.length - missingDates.length,
      cacheMisses: missingDates.length,
      durationMs: Date.now() - startMs,
    });

    return { today, series };
  }

  async getQueriesPerUser(input: { userId: string; range: QpuRange }): Promise<{
    total: number;
    last30d: number;
    last7d: number;
    byStatus: { completed: number; processing: number; failed: number };
    lastQueryAt: string | null;
  }> {
    const startMs = Date.now();
    const cacheKey = `sheriabot:analytics:qpu:${input.userId}:${input.range}`;

    const cached = await redis.get<string>(cacheKey);
    if (cached !== null) {
      logger.info({
        type: 'analytics_qpu_query',
        userId: input.userId,
        range: input.range,
        cacheHit: true,
        durationMs: Date.now() - startMs,
      });
      return JSON.parse(cached) as {
        total: number;
        last30d: number;
        last7d: number;
        byStatus: { completed: number; processing: number; failed: number };
        lastQueryAt: string | null;
      };
    }

    const now = Date.now();
    const thirtyDaysAgo = new Date(now - 30 * 86_400_000);
    const sevenDaysAgo = new Date(now - 7 * 86_400_000);

    const [total, last30d, last7d, byStatusRaw, lastRow] = await Promise.all([
      prisma.complianceQuery.count({ where: { userId: input.userId } }),
      prisma.complianceQuery.count({
        where: { userId: input.userId, createdAt: { gte: thirtyDaysAgo } },
      }),
      prisma.complianceQuery.count({
        where: { userId: input.userId, createdAt: { gte: sevenDaysAgo } },
      }),
      prisma.complianceQuery.groupBy({
        by: ['status'],
        where: { userId: input.userId },
        _count: { id: true },
      }),
      prisma.complianceQuery.findFirst({
        where: { userId: input.userId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);

    const byStatus = { completed: 0, processing: 0, failed: 0 };
    for (const row of byStatusRaw) {
      const s = row.status as string;
      if (s === 'completed') byStatus.completed = row._count.id;
      else if (s === 'processing') byStatus.processing = row._count.id;
      else if (s === 'failed') byStatus.failed = row._count.id;
      else logger.warn({ type: 'analytics_qpu_unknown_status', userId: input.userId, status: s });
    }

    const result = {
      total,
      last30d,
      last7d,
      byStatus,
      lastQueryAt: lastRow?.createdAt.toISOString() ?? null,
    };

    await redis.set(cacheKey, JSON.stringify(result), { ex: 120 });

    logger.info({
      type: 'analytics_qpu_query',
      userId: input.userId,
      range: input.range,
      cacheHit: false,
      durationMs: Date.now() - startMs,
    });

    return result;
  }

  async getFeedbackSummary(input: {
    range: FeedbackRange;
    page: number;
    pageSize: number;
  }): Promise<{
    aggregate: { totalVotes: number; upVotes: number; downVotes: number; upPct: number };
    rows: Array<{
      queryId: string;
      userId: string;
      userEmail: string;
      orgName: string | null;
      rating: 'up' | 'down';
      createdAt: string;
    }>;
    pagination: { page: number; pageSize: number; totalRows: number; totalPages: number };
  }> {
    const startMs = Date.now();
    const cacheKey = `sheriabot:analytics:feedback:${input.range}:${input.page}:${input.pageSize}`;

    const cached = await redis.get<string>(cacheKey);
    if (cached !== null) {
      const parsed = JSON.parse(cached) as {
        aggregate: { totalVotes: number; upVotes: number; downVotes: number; upPct: number };
        rows: Array<{
          queryId: string;
          userId: string;
          userEmail: string;
          orgName: string | null;
          rating: 'up' | 'down';
          createdAt: string;
        }>;
        pagination: { page: number; pageSize: number; totalRows: number; totalPages: number };
      };
      logger.info({
        type: 'analytics_feedback_summary_query',
        range: input.range,
        page: input.page,
        pageSize: input.pageSize,
        cacheHit: true,
        totalRows: parsed.pagination.totalRows,
        durationMs: Date.now() - startMs,
      });
      return parsed;
    }

    const daysBack = RANGE_DAYS[input.range];
    const rangeStart = new Date(Date.now() - daysBack * 86_400_000);
    const skip = (input.page - 1) * input.pageSize;

    const [aggregateRaw, totalRows, rows] = await Promise.all([
      prisma.queryFeedback.groupBy({
        by: ['rating'],
        where: { createdAt: { gte: rangeStart } },
        _count: { id: true },
      }),
      prisma.queryFeedback.count({ where: { createdAt: { gte: rangeStart } } }),
      prisma.queryFeedback.findMany({
        where: { createdAt: { gte: rangeStart } },
        select: {
          queryId: true,
          userId: true,
          rating: true,
          createdAt: true,
          user: { select: { email: true } },
          query: { select: { organizationId: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: input.pageSize,
      }),
    ]);

    // Batch-fetch org names for the page
    const orgIds = [
      ...new Set(
        rows
          .map(r => r.query.organizationId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const orgs =
      orgIds.length > 0
        ? await prisma.organization.findMany({
            where: { id: { in: orgIds } },
            select: { id: true, name: true },
          })
        : [];
    const orgMap = new Map(orgs.map(o => [o.id, o.name]));

    let upVotes = 0;
    let downVotes = 0;
    for (const row of aggregateRaw) {
      if (row.rating === 'up') upVotes = row._count.id;
      else if (row.rating === 'down') downVotes = row._count.id;
    }
    const totalVotes = upVotes + downVotes;
    const upPct = totalVotes > 0 ? Math.round((upVotes / totalVotes) * 1000) / 10 : 0;

    const result = {
      aggregate: { totalVotes, upVotes, downVotes, upPct },
      rows: rows.map(r => ({
        queryId: r.queryId,
        userId: r.userId,
        userEmail: r.user.email,
        orgName: r.query.organizationId ? (orgMap.get(r.query.organizationId) ?? null) : null,
        rating: r.rating as 'up' | 'down',
        createdAt: r.createdAt.toISOString(),
      })),
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        totalRows,
        totalPages: Math.ceil(totalRows / input.pageSize),
      },
    };

    await Promise.all([
      redis.set(cacheKey, JSON.stringify(result), { ex: 300 }),
      redis.sadd('sheriabot:idx:analytics:feedback-keys', cacheKey),
    ]);

    logger.info({
      type: 'analytics_feedback_summary_query',
      range: input.range,
      page: input.page,
      pageSize: input.pageSize,
      cacheHit: false,
      totalRows,
      durationMs: Date.now() - startMs,
    });

    return result;
  }
}

export const analyticsAdminService = new AnalyticsAdminService();
