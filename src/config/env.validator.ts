import { z } from 'zod';

/**
 * Production environment variable validation schema.
 * Stricter than app.config.ts — enforces minimum secret lengths,
 * URL formats, and production-only requirements.
 */

const isProduction = process.env.NODE_ENV === 'production';

const envSchema = z.object({
  // ── Application ──────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('4000').transform(Number).pipe(z.number().min(1).max(65535)),
  APP_URL: z.string().url('APP_URL must be a valid URL'),
  FRONTEND_URL: z.string().url('FRONTEND_URL must be a valid URL'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // ── Database ─────────────────────────────────────────────────────────────
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((url) => url.startsWith('postgresql://') || url.startsWith('postgres://'), {
      message: 'DATABASE_URL must be a valid PostgreSQL connection string',
    }),

  // ── Redis ────────────────────────────────────────────────────────────────
  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL is required')
    .refine((url) => url.startsWith('redis://') || url.startsWith('rediss://'), {
      message: 'REDIS_URL must be a valid Redis connection string',
    }),

  // ── JWT ──────────────────────────────────────────────────────────────────
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters')
    .refine((s) => !isProduction || !s.includes('change-this'), {
      message: 'JWT_SECRET must not contain placeholder values in production',
    }),
  JWT_EXPIRES_IN: z.string().default('7d'),
  REFRESH_TOKEN_SECRET: z
    .string()
    .min(32, 'REFRESH_TOKEN_SECRET must be at least 32 characters')
    .refine((s) => !isProduction || !s.includes('change-this'), {
      message: 'REFRESH_TOKEN_SECRET must not contain placeholder values in production',
    }),
  REFRESH_TOKEN_EXPIRES_IN: z.string().default('30d'),

  // ── Email (Resend) ──────────────────────────────────────────────────────
  RESEND_API_KEY: z.string().startsWith('re_', 'RESEND_API_KEY must start with re_'),
  FROM_EMAIL: z.string().email('FROM_EMAIL must be a valid email address'),

  // ── AI (Anthropic Claude) ───────────────────────────────────────────────
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-', 'ANTHROPIC_API_KEY must start with sk-ant-'),
  ANTHROPIC_MODEL: z.string().default('claude-3-haiku-20240307'),

  // ── Vector Database (Pinecone) ──────────────────────────────────────────
  PINECONE_API_KEY: z.string().min(1, 'PINECONE_API_KEY is required'),
  PINECONE_ENVIRONMENT: z.string().default('us-east-1-aws'),
  PINECONE_INDEX_NAME: z.string().default('sheriabot-legal-corpus'),

  // ── Storage (Cloudflare R2) ─────────────────────────────────────────────
  R2_ACCOUNT_ID: z.string().min(1, 'R2_ACCOUNT_ID is required'),
  R2_ACCESS_KEY_ID: z.string().min(1, 'R2_ACCESS_KEY_ID is required'),
  R2_SECRET_ACCESS_KEY: z.string().min(1, 'R2_SECRET_ACCESS_KEY is required'),
  R2_BUCKET_NAME: z.string().default('sheriabot-documents'),
  R2_PUBLIC_URL: z.string().url('R2_PUBLIC_URL must be a valid URL'),

  // ── Rate Limiting ───────────────────────────────────────────────────────
  RATE_LIMIT_MAX: z.string().default('100').transform(Number).pipe(z.number().positive()),
  RATE_LIMIT_WINDOW: z.string().default('15m'),

  // ── Admin Seed (optional, used by seed script) ──────────────────────────
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Validate environment variables.
 * Exits the process with a detailed error report on failure.
 */
export function validateEnvironment(): EnvConfig {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = error.issues.map(
        (issue) => `  - ${issue.path.join('.')}: ${issue.message}`
      );

      console.error(
        [
          '',
          '╔══════════════════════════════════════════════════╗',
          '║       ENVIRONMENT VALIDATION FAILED              ║',
          '╚══════════════════════════════════════════════════╝',
          '',
          ...errors,
          '',
          `Total errors: ${errors.length}`,
          'Fix the above variables in your .env file or Railway dashboard.',
          '',
        ].join('\n')
      );

      process.exit(1);
    }
    throw error;
  }
}

/**
 * Print a safe summary of loaded configuration (no secrets).
 */
export function printEnvSummary(env: EnvConfig): void {
  const mask = (s: string): string =>
    s.length > 8 ? s.slice(0, 4) + '****' + s.slice(-4) : '********';

  console.log(
    [
      '',
      '── Environment Summary ──────────────────────────────',
      `  NODE_ENV:       ${env.NODE_ENV}`,
      `  PORT:           ${env.PORT}`,
      `  APP_URL:        ${env.APP_URL}`,
      `  DATABASE_URL:   ${mask(env.DATABASE_URL)}`,
      `  REDIS_URL:      ${mask(env.REDIS_URL)}`,
      `  ANTHROPIC:      ${mask(env.ANTHROPIC_API_KEY)}`,
      `  PINECONE:       ${mask(env.PINECONE_API_KEY)}`,
      `  RESEND:         ${mask(env.RESEND_API_KEY)}`,
      `  R2 BUCKET:      ${env.R2_BUCKET_NAME}`,
      '────────────────────────────────────────────────────',
      '',
    ].join('\n')
  );
}
