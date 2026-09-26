import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Raw request body bytes, populated by the IntaSend webhook
     * content-type parser. Available only on routes that opt in
     * via parseAs: 'buffer'. Other routes receive undefined.
     */
    rawBody?: Buffer;

    /**
     * Authenticated user session attached to the request with verified organization ID.
     */
    user?: {
      id?: string;
      organizationId?: string;
      email?: string;
      role?: string;
    };
  }

  interface RouteShorthandOptions {
    /**
     * Request timeout in ms at the route level (e.g. 0 to disable for long-lived SSE streams).
     */
    requestTimeout?: number;
  }
}

export {};