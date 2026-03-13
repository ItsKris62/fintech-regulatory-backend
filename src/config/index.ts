/**
 * Config barrel export
 * Re-exports appConfig as `config` for modules that import from '@/config'
 */

export { appConfig as config, appConfig, isDevelopment, isProduction, isTest } from './app.config';
export type { AppConfig } from './app.config';
export * from './constants';
export {
  PLAN_ENTITLEMENTS,
  SubscriptionPlan,
} from './entitlements.config';
export type {
  PlanEntitlementConfig,
  PlanEntitlements,
  FeatureKey,
  QuotaEntitlement,
  StorageEntitlement,
  ApiAccessEntitlement,
  SupportTier,
  AnalyticsTier,
  KnowledgeBaseAccess,
} from './entitlements.config';
