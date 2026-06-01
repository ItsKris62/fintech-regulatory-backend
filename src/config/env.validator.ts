import { z } from 'zod';

/**
 * Production environment variable validation schema.
 * Stricter than app.config.ts - enforces minimum secret lengths,
 * URL formats, and production-only requirements.
 */

const envSchema = z.object({
  // -- Application ----------------------------------------------------------
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('4000').transform(Number).pipe(z.number().min(1).max(65535)),
  APP_URL: z.string().url('APP_URL must be a valid URL'),
  FRONTEND_URL: z.string().url('FRONTEND_URL must be a valid URL'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // -- Database -------------------------------------------------------------
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((url) => url.startsWith('postgresql://') || url.startsWith('postgres://'), {
      message: 'DATABASE_URL must be a valid PostgreSQL connection string',
    }),

  // Optional direct connection URL for Prisma migrations (Supabase requires this)
  DIRECT_URL: z
    .string()
    .optional()
    .refine((url) => !url || url.startsWith('postgresql://') || url.startsWith('postgres://'), {
      message: 'DIRECT_URL must be a valid PostgreSQL connection string',
    }),

  // -- Upstash Redis --------------------------------------------------------
  UPSTASH_REDIS_REST_URL: z
    .string()
    .min(1, 'UPSTASH_REDIS_REST_URL is required')
    .refine((url) => url.startsWith('https://'), {
      message: 'UPSTASH_REDIS_REST_URL must be a valid HTTPS URL',
    }),
  UPSTASH_REDIS_REST_TOKEN: z
    .string()
    .min(1, 'UPSTASH_REDIS_REST_TOKEN is required'),

  // -- Supabase Auth --------------------------------------------------------
  SUPABASE_URL: z
    .string()
    .url('SUPABASE_URL must be a valid URL'),
  SUPABASE_ANON_KEY: z
    .string()
    .min(1, 'SUPABASE_ANON_KEY is required'),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  SUPABASE_JWT_SECRET: z
    .string()
    .min(32, 'SUPABASE_JWT_SECRET must be at least 32 characters'),

  // -- Email (Resend) -------------------------------------------------------
  RESEND_API_KEY: z.string().startsWith('re_', 'RESEND_API_KEY must start with re_'),
  FROM_EMAIL: z.string().email('FROM_EMAIL must be a valid email address'),

  // -- AI (Anthropic Claude) ------------------------------------------------
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-', 'ANTHROPIC_API_KEY must start with sk-ant-'),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5-20251001'),

  // -- Vector Database (Pinecone) ------------------------------------------
  PINECONE_API_KEY: z.string().min(1, 'PINECONE_API_KEY is required'),
  PINECONE_ENVIRONMENT: z.string().default('us-east-1-aws'),
  PINECONE_INDEX_NAME: z.string().default('sheriabot-legal-corpus'),

  // -- Storage (Cloudflare R2) ---------------------------------------------
  R2_ACCOUNT_ID: z.string().min(1, 'R2_ACCOUNT_ID is required'),
  R2_ACCESS_KEY_ID: z.string().min(1, 'R2_ACCESS_KEY_ID is required'),
  R2_SECRET_ACCESS_KEY: z.string().min(1, 'R2_SECRET_ACCESS_KEY is required'),
  R2_BUCKET_NAME: z.string().default('sheriabot-documents'),
  R2_PUBLIC_URL: z.string().url('R2_PUBLIC_URL must be a valid URL'),
  MALWARE_SCAN_ENABLED: z.coerce.boolean().default(false),
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

  // -- Rate Limiting --------------------------------------------------------
  RATE_LIMIT_MAX: z.string().default('100').transform(Number).pipe(z.number().positive()),
  RATE_LIMIT_WINDOW: z.string().default('15m'),

  // -- Admin Seed (optional, used by seed script) --------------------------
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),

  // -- Vault Reconciliation Cron -------------------------------------------
  // When true (default), the nightly cron logs orphans but does not delete.
  // Flip to false after reviewing 2 nights of dry-run logs.
  VAULT_RECONCILIATION_DRY_RUN: z.coerce.boolean().default(true).optional(),
  VAULT_RECONCILIATION_VERIFY_HASHES: z.coerce.boolean().default(false).optional(),
  VAULT_DELETED_RETENTION_DAYS: z.coerce.number().int().positive().default(30).optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Validate environment variables.
 * Exits the process with a value-safe error report on failure.
 */
export function validateEnvironment(): EnvConfig {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const invalidVariables = error.issues.map(
        (issue) => `  - ${issue.path.join('.') || '<root>'}`
      );

      console.error(
        [
          '',
          'ENVIRONMENT VALIDATION FAILED',
          '',
          'Invalid variable names only; values and parsed defaults are intentionally not logged.',
          ...invalidVariables,
          '',
          `Total errors: ${invalidVariables.length}`,
          'Fix the above variables in your .env file or Render/Supabase dashboard.',
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
      '-- Environment Summary ------------------------------',
      `  NODE_ENV:         ${env.NODE_ENV}`,
      `  PORT:             ${env.PORT}`,
      `  APP_URL:          ${env.APP_URL}`,
      `  DATABASE_URL:     ${mask(env.DATABASE_URL)}`,
      `  SUPABASE_URL:     ${env.SUPABASE_URL}`,
      `  UPSTASH_URL:      ${mask(env.UPSTASH_REDIS_REST_URL)}`,
      `  ANTHROPIC:        ${mask(env.ANTHROPIC_API_KEY)}`,
      `  PINECONE:         ${mask(env.PINECONE_API_KEY)}`,
      `  RESEND:           ${mask(env.RESEND_API_KEY)}`,
      `  R2 BUCKET:        ${env.R2_BUCKET_NAME}`,
      '----------------------------------------------------',
      '',
    ].join('\n')
  );
}
