import { appConfig } from '@/config/app.config';
import { logger } from '@/utils/logger';

type FetchLike = typeof fetch;

export interface PostHogQueryConfig {
  personalApiKey?: string;
  host?: string;
  projectId?: string;
}

export interface QueryClientDependencies {
  fetchImpl?: FetchLike;
  configProvider?: () => PostHogQueryConfig;
}

export type HogQLQueryResult =
  | { available: true; results: unknown[][] }
  | { available: false; reason: string };

interface HogQLQueryResponse {
  results?: unknown[][];
}

const QUERY_TIMEOUT_MS = 5000;

function isConfigured(config: PostHogQueryConfig): boolean {
  return Boolean(config.personalApiKey && config.host && config.projectId);
}

/**
 * Generic read-only HogQL query client, pattern-matched to
 * src/modules/agents/sales/engagement-lookup.service.ts (same config shape,
 * same auth/timeout/degradation contract). Never calls capture, identify, or
 * any write/tracking endpoint. Degrades to { available: false } on missing
 * config, non-2xx response, or any network/parse failure - callers must never
 * fail a run because PostHog is unreachable.
 */
export class PostHogQueryClient {
  private readonly fetchImpl: FetchLike;
  private readonly configProvider: () => PostHogQueryConfig;

  constructor(dependencies: QueryClientDependencies = {}) {
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.configProvider = dependencies.configProvider ?? (() => appConfig.posthog);
  }

  async runHogQLQuery(query: string, values: Record<string, unknown> = {}): Promise<HogQLQueryResult> {
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
          query: { kind: 'HogQLQuery', query, values },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.warn({ type: 'posthog_query_failed', status: response.status });
        return { available: false, reason: `posthog_http_${response.status}` };
      }

      const payload = (await response.json()) as HogQLQueryResponse;
      return { available: true, results: payload.results ?? [] };
    } catch (error: unknown) {
      logger.warn({ type: 'posthog_query_failed', error: error instanceof Error ? error.message : String(error) });
      return { available: false, reason: 'posthog_request_failed' };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const postHogQueryClient = new PostHogQueryClient();
