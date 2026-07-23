// Departments with a fully-specified getMetrics shape. Marketing / regIntel /
// chiefOfStaff are called by n8n's "Monday Board Brief" workflow too, but the
// integration brief never defined their output shapes - rather than fabricate
// one, getMetrics() rejects any department outside this list with a clear
// error (see metrics.service.ts), and this list is the source of truth.
export const SUPPORTED_METRICS_DEPARTMENTS = ['product', 'sales', 'security'] as const;
export type SupportedMetricsDepartment = (typeof SUPPORTED_METRICS_DEPARTMENTS)[number];

export function isSupportedMetricsDepartment(value: string): value is SupportedMetricsDepartment {
  return (SUPPORTED_METRICS_DEPARTMENTS as readonly string[]).includes(value);
}

export interface GetMetricsInput {
  department: string;
  window: string;
  jurisdictions?: string;
  detail?: string;
}

export interface ProductMetrics {
  queries: number;
  baselineQueries: number;
}

/**
 * usageIntensity is a provisional 0-1 heuristic (PostHog eventCount7d linearly
 * scaled against USAGE_INTENSITY_SATURATION_EVENTS, capped at 1) - there is no
 * existing usage-scoring model in the codebase to reuse. jurisdiction has no
 * backing field anywhere on Organization or any 1:1-related model (checked:
 * PilotAccess, CustomFramework, GeneratedPolicy all carry their own
 * content/framework jurisdiction, never an org "home" jurisdiction) - defaults
 * to 'Kenya', the platform's only current market, rather than fabricate a
 * per-org value. topFeatures has no per-feature usage pipeline (no PostHog
 * group-based capture exists in this codebase) so it is always an honest [].
 * Flagging all three for review rather than presenting them as solved.
 */
export interface SalesOrgSignal {
  orgId: string;
  orgName: string;
  tier: string;
  usageIntensity: number;
  jurisdiction: string;
  topFeatures: string[];
}

export interface SalesMetrics {
  orgs: SalesOrgSignal[];
}

/**
 * hasCriticalIssue deliberately deviates from the brief's exact
 * `{ hasCriticalIssue: boolean }` shape by adding `dataAvailable`. The check
 * is now real (see SentryQueryService.checkCriticalIssues in
 * src/lib/sentry-query.service.ts), but the Sentry Issues API call can still
 * fail (rate limit, timeout, missing/invalid token) - `dataAvailable: false`
 * means "we could not reliably check," never "we checked and it's clean."
 * Always collapsing a failed check to a bare `false` would read as "no
 * critical issue" to n8n's Sentry Watcher when the true state is "never
 * checked" - silently suppressing a real alert path is worse than an honest,
 * differently-shaped signal. n8n's W-SEC-01/W-SEC-03 workflows still need to
 * branch on `dataAvailable`, not just `hasCriticalIssue` - that wiring hasn't
 * been done yet.
 */
export interface SecurityMetrics {
  hasCriticalIssue: boolean;
  dataAvailable: boolean;
  aiSpendVsCeiling: number;
}

export type GetMetricsResult = ProductMetrics | SalesMetrics | SecurityMetrics;
