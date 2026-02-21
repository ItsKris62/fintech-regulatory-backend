import { router, baseProcedure } from './init';
import { 
  isAuthenticated, 
  isAdmin, 
  isRegulator, 
  isStartup,
  isEnterprise,
  logged 
} from './middleware';

// Export router builder for use in your controllers
export { router }; 

// --- Core Procedures ---

/**
 * Public Procedure
 * Accessible by anyone, but still tracked by the logging middleware.
 */
export const publicProcedure = baseProcedure.use(logged);

/**
 * Protected Procedure
 * Requires a valid JWT. Guarantees `ctx.user` is present in downstream resolvers.
 */
export const protectedProcedure = publicProcedure.use(isAuthenticated);

// --- Role-Specific Procedures ---

export const adminProcedure = protectedProcedure.use(isAdmin);
export const regulatorProcedure = protectedProcedure.use(isRegulator);
export const startupProcedure = protectedProcedure.use(isStartup);
export const enterpriseProcedure = protectedProcedure.use(isEnterprise);