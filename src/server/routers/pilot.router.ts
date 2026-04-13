/**
 * Pilot Router
 *
 * Admin-only tRPC procedures for the Pilot Programme dashboard.
 * All procedures require ADMIN role (via adminProcedure).
 *
 * Procedures:
 *   pilot.getStats       — aggregate stats (totals, cohorts)
 *   pilot.listTesters    — per-tester rows with engagement metrics
 */

import { router, adminProcedure } from '../trpc/trpc';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';

const MS_PER_DAY    = 1000 * 60 * 60 * 24;
const MAX_ACTIONS   = 10; // total distinct PilotAction values

export const pilotRouter = router({
  /**
   * Aggregate stats for the pilot programme header cards.
   */
  getStats: adminProcedure.query(async () => {
    const now = new Date();

    const [total, expiredCount, convertedCount, totalEvents, cohortRows] = await Promise.all([
      prisma.user.count({ where: { isPilot: true } }),
      prisma.user.count({ where: { isPilot: true, pilotExpiresAt: { lte: now } } }),
      prisma.user.count({ where: { isPilot: true, pilotConvertedAt: { not: null } } }),
      prisma.pilotEvent.count(),
      prisma.user.findMany({
        where:    { isPilot: true, pilotCohort: { not: null } },
        select:   { pilotCohort: true },
        distinct: ['pilotCohort'],
      }),
    ]);

    const active = total - expiredCount;

    logger.info({ type: 'PILOT_ADMIN_GET_STATS', total, active, expiredCount, convertedCount });

    return {
      total,
      active,
      expired:     expiredCount,
      converted:   convertedCount,
      totalEvents,
      cohorts:     cohortRows.map((r) => r.pilotCohort ?? '').filter(Boolean),
    };
  }),

  /**
   * Per-tester rows with engagement metrics.
   * Sorted newest-first by pilotStartedAt.
   */
  listTesters: adminProcedure.query(async () => {
    const now = new Date();

    const users = await prisma.user.findMany({
      where:   { isPilot: true },
      select: {
        id:               true,
        email:            true,
        fullName:         true,
        pilotCohort:      true,
        pilotStartedAt:   true,
        pilotExpiresAt:   true,
        pilotConvertedAt: true,
        organization:     { select: { name: true } },
        pilotEvents:      { select: { action: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
      },
      orderBy: { pilotStartedAt: 'desc' },
    });

    logger.info({ type: 'PILOT_ADMIN_LIST_TESTERS', count: users.length });

    return users.map((user) => {
      const isExpired   = user.pilotExpiresAt !== null && user.pilotExpiresAt <= now;
      const isConverted = user.pilotConvertedAt !== null;
      const status      = isConverted ? 'converted' : isExpired ? 'expired' : 'active';

      const daysRemaining = user.pilotExpiresAt && !isExpired
        ? Math.max(0, Math.ceil((user.pilotExpiresAt.getTime() - now.getTime()) / MS_PER_DAY))
        : 0;

      const daysSinceStart = user.pilotStartedAt
        ? Math.floor((now.getTime() - user.pilotStartedAt.getTime()) / MS_PER_DAY)
        : 0;

      // Engagement score = count of distinct action types used (max 10)
      const distinctActions  = new Set(user.pilotEvents.map((e) => e.action));
      const engagementScore  = distinctActions.size;
      const engagementPercent = Math.round((engagementScore / MAX_ACTIONS) * 100);

      // Events grouped by action
      const eventsByAction: Record<string, number> = {};
      for (const event of user.pilotEvents) {
        eventsByAction[event.action] = (eventsByAction[event.action] ?? 0) + 1;
      }

      const lastEventAt = user.pilotEvents[0]?.createdAt ?? null;

      return {
        id:               user.id,
        email:            user.email,
        fullName:         user.fullName,
        organization:     user.organization?.name ?? null,
        cohort:           user.pilotCohort,
        pilotStartedAt:   user.pilotStartedAt?.toISOString()   ?? null,
        pilotExpiresAt:   user.pilotExpiresAt?.toISOString()   ?? null,
        pilotConvertedAt: user.pilotConvertedAt?.toISOString() ?? null,
        status,
        daysRemaining,
        daysSinceStart,
        engagementScore,
        engagementPercent,
        totalEvents: user.pilotEvents.length,
        lastEventAt: lastEventAt?.toISOString() ?? null,
        eventsByAction,
      };
    });
  }),
});
