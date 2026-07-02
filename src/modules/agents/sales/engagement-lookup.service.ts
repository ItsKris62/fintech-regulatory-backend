import { appConfig } from '@/config/app.config';
import { logger } from '@/utils/logger';
import type { EngagementContext } from './types';

type FetchLike = typeof fetch;

export interface PostHogQueryConfig {
  personalApiKey?: string;
  host?: string;
  projectId?: string;
}

export interface EngagementLookupDependencies {
  fetchImpl?: FetchLike;
  configProvider?: () => PostHogQueryConfig;
}

interface HogQLQueryResponse {
  results?: Array<[string | null, number | null]>;
}

const QUERY_TIMEOUT_MS = 5000;

function isConfigured(config: PostHogQueryConfig): boolean {
  return Boolean(config.personalApiKey && config.host && config.projectId);
}

/**
 * Read-only HogQL query against PostHog's Query API. Never calls capture,
 * identify, or any write/tracking endpoint. Degrades to { available: false }
 * on missing config, missing contact email, non-2xx response, or any
 * network/parse failure - the sales agent must never fail a run because
 * engagement data is unreachable.
 */
export class SalesEngagementLookupService {
  private readonly fetchImpl: FetchLike;
  private readonly configProvider: () => PostHogQueryConfig;

  constructor(dependencies: EngagementLookupDependencies = {}) {
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.configProvider = dependencies.configProvider ?? (() => appConfig.posthog);
  }

  async lookup(organizationId: string, contactEmail: string | null): Promise<EngagementContext> {
    if (!contactEmail) {
      return { available: false, reason: 'no_contact_email' };
    }

    const config = this.configProvider();
    if (!isConfigured(config)) {
      return { available: false, reason: 'posthog_not_configured' };
    }

    const { personalApiKey, host, projectId } = config;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);

    try {
      const response = await this.fetchImpl(`${host}/api/projects/${projectId}/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${personalApiKey}`,
        },
        body: JSON.stringify({
          query: {
            kind: 'HogQLQuery',
            query: 'SELECT max(timestamp), count() FROM events WHERE person.properties.email = {email} AND timestamp > now() - INTERVAL 7 DAY',
            values: { email: contactEmail },
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.warn({ type: 'sales_engagement_lookup_failed', organizationId, status: response.status });
        return { available: false, reason: `posthog_http_${response.status}` };
      }

      const payload = (await response.json()) as HogQLQueryResponse;
      const row = payload.results?.[0];
      const lastSeenAt = row?.[0] ?? null;
      const eventCount7d = typeof row?.[1] === 'number' ? row[1] : 0;

      logger.info({ type: 'sales_engagement_lookup', organizationId, available: true, eventCount7d });
      return { available: true, lastSeenAt, eventCount7d };
    } catch (error: unknown) {
      logger.warn({ type: 'sales_engagement_lookup_failed', organizationId, error: error instanceof Error ? error.message : String(error) });
      return { available: false, reason: 'posthog_request_failed' };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const salesEngagementLookupService = new SalesEngagementLookupService();
