import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

/**
 * Security plugin — production-hardened Helmet configuration.
 *
 * Registers Helmet with strict CSP, HSTS, and other headers
 * tuned for a JSON API (no inline scripts, no frames).
 */
async function securityPlugin(app: FastifyInstance): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';

  await app.register(helmet, {
    // Content Security Policy — strict in production
    contentSecurityPolicy: isProduction
      ? {
          directives: {
            defaultSrc: ["'none'"],
            scriptSrc: ["'none'"],
            styleSrc: ["'none'"],
            imgSrc: ["'none'"],
            connectSrc: ["'self'"],
            fontSrc: ["'none'"],
            objectSrc: ["'none'"],
            frameSrc: ["'none'"],
            frameAncestors: ["'none'"],
            formAction: ["'self'"],
            baseUri: ["'self'"],
          },
        }
      : false,

    // HTTP Strict Transport Security — 1 year, include subdomains, preload
    hsts: isProduction
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,

    // Prevent framing
    frameguard: { action: 'deny' },

    // Referrer policy
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },

    // Don't sniff MIME types
    noSniff: true,

    // XSS filter
    xssFilter: true,

    // Don't embed in other origins
    crossOriginEmbedderPolicy: false, // false for APIs that serve to browsers
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },

    // Hide Fastify / Express identifier
    hidePoweredBy: true,
  });
}

export default fp(securityPlugin, {
  name: 'security-headers',
  fastify: '5.x',
});
