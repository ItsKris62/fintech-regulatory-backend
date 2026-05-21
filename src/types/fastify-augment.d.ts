import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Raw request body bytes, populated by the IntaSend webhook
     * content-type parser. Available only on routes that opt in
     * via parseAs: 'buffer'. Other routes receive undefined.
     */
    rawBody?: Buffer;
  }
}

export {};