import { router } from '../trpc/trpc';
import { authRouter } from '../routers/auth.router';
import { userRouter } from '../routers/user.router';
import { organizationRouter } from '../routers/organization.router';
import { policyRouter } from '../routers/policy.router';
import { complianceRouter } from '../routers/compliance.router';
import { checklistRouter } from '../routers/checklist.router';
import { gapAnalysisRouter } from '../routers/gap-analysis.router';
import { complianceDashboardRouter } from '../routers/compliance-dashboard.router';
import { documentRouter } from '../routers/document.router';
import { contentRouter } from '../routers/content.router';
import { adminRouter } from '../routers/admin.router';
import { notificationRouter } from '../routers/notification.router';
import { analyticsRouter } from '../routers/analytics.router';

/**
 * Root Application Router
 *
 * Combines all sub-routers into a single router.
 * This is the main entry point for all tRPC procedures.
 *
 * Routes:
 * - /trpc/auth.*         - Authentication (register, login, password reset, etc.)
 * - /trpc/user.*         - User management (profile, preferences, password, account)
 * - /trpc/organization.* - Organization CRUD and member management
 * - /trpc/policy.*       - Policy CRUD + AI generation + export
 * - /trpc/compliance.*   - Compliance queries with RAG + document search
 * - /trpc/document.*     - Document upload/download with R2 storage
 * - /trpc/content.*      - Blog posts, KB articles, and content management
 * - /trpc/admin.*        - Admin operations (stats, users, health, logs)
 * - /trpc/notification.* - Notifications (list, mark read, preferences)
 * - /trpc/analytics.*    - Analytics (dashboard, trends, reports, export)
 */
export const appRouter = router({
  auth: authRouter,
  user: userRouter,
  organization: organizationRouter,
  policy: policyRouter,
  compliance: complianceRouter,
  checklist: checklistRouter,
  gapAnalysis: gapAnalysisRouter,
  complianceDashboard: complianceDashboardRouter,
  document: documentRouter,
  content: contentRouter,
  admin: adminRouter,
  notification: notificationRouter,
  analytics: analyticsRouter,
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