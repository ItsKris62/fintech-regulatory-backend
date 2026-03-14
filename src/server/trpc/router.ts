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
import { supportRouter } from '../routers/support.router';
import { adminSupportRouter } from '../routers/adminSupport.router';

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
 * - /trpc/support.*       - User support ticket submission and tracking
 * - /trpc/adminSupport.*  - Admin ticket management (ADMIN role only)
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
  support: supportRouter,
  adminSupport: adminSupportRouter,
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