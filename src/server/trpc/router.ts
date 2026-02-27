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