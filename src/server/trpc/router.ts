import { router } from './trpc';
import { authRouter } from '../routers/auth.router';
import { userRouter } from '../routers/user.router';
import { organizationRouter } from '../routers/organization.router';
import { policyRouter } from '../routers/policy.router';
import { complianceRouter } from '../routers/compliance.router';
import { documentRouter } from '../routers/document.router';
import { contentRouter } from '../routers/content.router';
import { adminRouter } from '../routers/admin.router';
import { notificationRouter } from '../routers/notification.router';
import { analyticsRouter } from '../routers/analytics.router';
import { vaultRouter } from '../routers/vault.router';
import { billingRouter } from '../routers/billing.router';
import { paymentRouter } from '../routers/payment.router';
import { supportRouter } from '../routers/support.router';
import { adminSupportRouter } from '../routers/adminSupport.router';
import { calendarRouter } from '../routers/calendar.router';
import { usageRouter } from '../routers/usage.router';
import { trialRouter } from '../routers/trial.router';
import { sessionRouter } from '../routers/session.router';
import { pilotRouter } from '../routers/pilot.router';
import { checklistRouter } from '../routers/checklist.router';
import { complianceDashboardRouter } from '../routers/compliance-dashboard.router';
import { gapAnalysisRouter } from '../routers/gap-analysis.router';
import { alertRouter } from '../routers/alert.router';
import { adminMarketingRouter } from '../routers/adminMarketing.router';
import { publicMarketingRouter } from '../routers/publicMarketing.router';
import { enterprisePolicyRouter } from '../routers/enterprise-policy.router';
import { applicationRouter } from '../routers/application.router';

/**
 * Root Application Router
 *
 * Combines all sub-routers into a single router.
 * This is the main entry point for all tRPC procedures.
 *
 * Routes:
 * - /trpc/auth.*         - Authentication (register, login, etc.)
 * - /trpc/user.*         - User management (profile, preferences, etc.)
 * - /trpc/organization.* - Organization CRUD
 * - /trpc/policy.*       - Policy CRUD + AI generation
 * - /trpc/compliance.*   - Compliance queries with RAG
 * - /trpc/document.*     - Document upload/download
 * - /trpc/admin.*        - Admin operations
 * - /trpc/notification.* - Notifications (list, mark-read, preferences)
 * - /trpc/analytics.*    - Analytics dashboards and reports
 * - /trpc/vault.*        - Organisation Document Vault (upload/download/manage compliance docs)
 * - /trpc/billing.*       - Plan, entitlements and usage data
 * - /trpc/usage.*         - Per-org monthly usage tracking, history and comparison
 * - /trpc/support.*       - User support ticket submission and tracking
 * - /trpc/adminSupport.*  - Admin ticket management (ADMIN role only)
 * - /trpc/pilot.*         - Pilot Programme dashboard (ADMIN role only)
 * - /trpc/checklist.*     - AI checklist generation, status polling, retry and progress tracking
 * - /trpc/complianceDashboard.* - Startup dashboard compliance score and category checklist data
 * - /trpc/gapAnalysis.*   - Policy gap analysis upload, polling and result retrieval
 * - /trpc/enterprisePolicy.* - Enterprise AI Policy Generator (ENTERPRISE tier only)
 */
export const appRouter = router({
  auth: authRouter,
  user: userRouter,
  organization: organizationRouter,
  policy: policyRouter,
  compliance: complianceRouter,
  document: documentRouter,
  content: contentRouter,
  admin: adminRouter,
  notification: notificationRouter,
  analytics: analyticsRouter,
  vault: vaultRouter,
  billing: billingRouter,
  payment: paymentRouter,
  support: supportRouter,
  adminSupport: adminSupportRouter,
  calendar: calendarRouter,
  usage: usageRouter,
  trial: trialRouter,
  session: sessionRouter,
  pilot: pilotRouter,
  checklist: checklistRouter,
  complianceDashboard: complianceDashboardRouter,
  gapAnalysis: gapAnalysisRouter,
  alert: alertRouter,
  adminMarketing:   adminMarketingRouter,
  publicMarketing:  publicMarketingRouter,
  enterprisePolicy: enterprisePolicyRouter,
  application: applicationRouter,
});

/**
 * Export type definition of API
 * 
 * This type is used on the frontend for end-to-end type safety.
 * The frontend can import this type to get full autocomplete and
 * type checking for all API calls.
 * 
 * @example
 * // On frontend:
 * import type { AppRouter } from '@/server/trpc/router';
 * 
 * const client = createTRPCProxyClient<AppRouter>({
 *   links: [httpBatchLink({ url: 'http://localhost:3001/trpc' })],
 * });
 */
export type AppRouter = typeof appRouter;
