import { initTRPC } from '@trpc/server';
import { Context } from './context';

/**
 * Initialize tRPC with context type
 * We also add a custom error formatter to handle validation errors gracefully.
 */
const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        // If you use Zod for validation, this passes the specific field errors to the frontend
        zodError:
          error.code === 'BAD_REQUEST' && error.cause instanceof Error
            ? error.cause.message
            : null,
      },
    };
  },
});

export const router = t.router;
export const middleware = t.middleware;
export const baseProcedure = t.procedure;