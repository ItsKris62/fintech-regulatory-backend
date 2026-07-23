import { appConfig } from '@/config/app.config';
import { cache } from '@/lib/redis/cache.service';
import { logger } from '@/utils/logger';
import { sanitizeErrorMessage } from '@/utils/error-sanitizer';

type FetchLike = typeof fetch;

export interface SentryQueryConfig {
  apiToken?: string;
  org?: string;
  project?: string;
}

export interface SentryCriticalIssueCheck {
  hasCriticalIssue: boolean;
  dataAvailable: boolean;
}

export interface SentryQueryServiceDependencies {
  fetchImpl?: FetchLike;
  configProvider?: () => SentryQueryConfig;
}

/**
 * Sentry Issues API response shape is NOT confirmed against a real response
 * anywhere in this repo - @sentry/node (the outbound error-capture SDK used
 * in src/lib/sentry.ts) has no types for this separate Web/REST API. Field
 * names follow Sentry's publicly documented Issues API (level, status,
 * count as a string) - correct if a live response disagrees.
 */
interface SentryIssue {
  level: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
  status: 'unresolved' | 'resolved' | 'ignored';
  count: string;
}

const REQUEST_TIMEOUT_MS = 5000;
const CRITICAL_ISSUE_CACHE_KEY = 'sentry:critical-issue-check';
// 300s (5 min): low end of the 300-600s range from scoping. W-SEC-03 polls
// every 15 min, so this still cuts Sentry calls ~3x while staying more
// responsive than the 10 min end for W-SEC-01's hourly check.
const CRITICAL_ISSUE_CACHE_TTL_SECONDS = 300;
const CRITICAL_LEVELS = new Set(['fatal', 'error']);

// This org's DSN ingest host is *.de.sentry.io (EU data region), and Sentry's
// Issues API must be called against the matching region host - the default
// sentry.io host does not transparently proxy EU-region orgs. See
// https://docs.sentry.io/api/ and https://sentry.zendesk.com/hc/en-us/articles/25074658211227-Sentry-s-EU-Region-FAQ
const SENTRY_API_BASE_URL = 'https://de.sentry.io/api/0';

function isConfigured(config: SentryQueryConfig): boolean {
  return Boolean(config.apiToken && config.org && config.project);
}

/**
 * Read-only query against Sentry's Issues API to check for unresolved
 * fatal/error-level issues. Never calls any write endpoint.
 *
 * hasCriticalIssue: false with dataAvailable: false means "we could not
 * reliably check" (missing config, timeout, non-2xx, network/parse error).
 * This must never be presented the same as a confirmed-clean check
 * (dataAvailable: true) - callers must branch on dataAvailable, not just
 * hasCriticalIssue.
 */
export class SentryQueryService {
  private readonly fetchImpl: FetchLike;
  private readonly configProvider: () => SentryQueryConfig;

  constructor(dependencies: SentryQueryServiceDependencies = {}) {
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.configProvider = dependencies.configProvider ?? (() => appConfig.sentry);
  }

  async checkCriticalIssues(): Promise<SentryCriticalIssueCheck> {
    const config = this.configProvider();
    if (!isConfigured(config)) {
      logger.warn({ type: 'sentry_critical_issue_check_failed', reason: 'sentry_not_configured' });
      return { hasCriticalIssue: false, dataAvailable: false };
    }

    try {
      const hasCriticalIssue = await cache.getOrSet(
        CRITICAL_ISSUE_CACHE_KEY,
        () => this.fetchCriticalIssueState(config),
        CRITICAL_ISSUE_CACHE_TTL_SECONDS,
      );
      return { hasCriticalIssue, dataAvailable: true };
    } catch (error: unknown) {
      logger.warn({ type: 'sentry_critical_issue_check_failed', error: sanitizeErrorMessage(error) });
      return { hasCriticalIssue: false, dataAvailable: false };
    }
  }

  private async fetchCriticalIssueState(config: SentryQueryConfig): Promise<boolean> {
    const { apiToken, org, project } = config;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await this.fetchImpl(
        `${SENTRY_API_BASE_URL}/projects/${org}/${project}/issues/?query=is:unresolved&statsPeriod=24h`,
        {
          headers: { Authorization: `Bearer ${apiToken}` },
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`sentry_http_${response.status}`);
      }

      const issues = (await response.json()) as SentryIssue[];
      return issues.some((issue) => issue.status === 'unresolved' && CRITICAL_LEVELS.has(issue.level));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const sentryQueryService = new SentryQueryService();
