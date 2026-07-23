import { logger } from '@/utils/logger';
import { notificationDedupe as defaultNotificationDedupe } from '@/lib/redis/dedupe';

export interface ShouldNotifyInput {
  dedupeKey: string;
  ttlSeconds: number;
}

type NotificationDedupeFn = (dedupeKey: string, ttlSeconds: number) => Promise<boolean>;

export interface AutomationNotifyServiceDependencies {
  notificationDedupe?: NotificationDedupeFn;
}

export class AutomationNotifyService {
  private readonly notificationDedupe: NotificationDedupeFn;

  constructor(dependencies: AutomationNotifyServiceDependencies = {}) {
    this.notificationDedupe = dependencies.notificationDedupe ?? defaultNotificationDedupe;
  }

  /**
   * This gate is mechanically correct and reusable by any workflow key - it
   * only dedupes on whatever boolean the caller passes in, regardless of
   * where that boolean comes from. hasCriticalIssue in
   * agents.automation.getMetrics(scope: 'security') is now a real Sentry
   * check (see SentryQueryService in src/lib/sentry-query.service.ts) rather
   * than a hardcoded false, but that change alone doesn't touch this dedup
   * gate's behavior. W-SEC-01/W-SEC-03's n8n workflows still need updating
   * to branch on dataAvailable, not just hasCriticalIssue - that's separate,
   * unbuilt work this gate can't address on its own.
   */
  async shouldNotify(input: ShouldNotifyInput): Promise<{ shouldNotify: boolean }> {
    const result = await this.notificationDedupe(input.dedupeKey, input.ttlSeconds);
    logger.info({ type: 'automation_should_notify_checked', dedupeKey: input.dedupeKey, result });
    return { shouldNotify: result };
  }
}

export const automationNotifyService = new AutomationNotifyService();
