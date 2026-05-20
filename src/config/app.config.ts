import { z } from 'zod';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Environment variable schema with validation
 * Ensures all required environment variables are present and valid
 */
const envSchema = z.object({
  // App Configuration
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).pipe(z.number().min(1).max(65535)).default(4000),
  APP_URL: z.string().url(),
  // Comma-separated origins are supported for CORS (e.g. apex + www + Vercel previews).
  // The first value is the canonical URL used in links/emails.
  FRONTEND_URL: z.string().min(1),

  // Database
  DATABASE_URL: z.string().min(1, 'Database URL is required'),
  DIRECT_URL: z.string().optional(),

  // Upstash Redis
  UPSTASH_REDIS_REST_URL: z.string().min(1, 'Upstash Redis REST URL is required'),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1, 'Upstash Redis REST token is required'),

  // Supabase Auth
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1, 'Supabase anon key is required'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'Supabase service role key is required'),
  SUPABASE_JWT_SECRET: z.string().min(32, 'Supabase JWT secret must be at least 32 characters'),

  // Email
  RESEND_API_KEY: z.string().startsWith('re_', 'Invalid Resend API key'),
  FROM_EMAIL: z.string().email(),
  SUPPORT_EMAIL_RECIPIENT: z.string().email().optional().default('support@sheriabot.com'),

  // Anthropic Claude
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-', 'Invalid Anthropic API key'),
  ANTHROPIC_MODEL: z.string().default('claude-3-haiku-20240307'),

  // Pinecone
  PINECONE_API_KEY: z.string().min(1, 'Pinecone API key is required'),
  PINECONE_ENVIRONMENT: z.string().default('us-east-1-aws'),
  PINECONE_INDEX_NAME: z.string().default('sheriabot-legal-corpus'),

  // Cloudflare R2  -  private bucket
  R2_ACCOUNT_ID: z.string().min(1, 'R2 account ID is required'),
  R2_ACCESS_KEY_ID: z.string().min(1, 'R2 access key ID is required'),
  R2_SECRET_ACCESS_KEY: z.string().min(1, 'R2 secret access key is required'),
  R2_BUCKET_NAME: z.string().default('sheriabot-documents'),
  R2_PUBLIC_URL: z.string().url(),
  MALWARE_SCAN_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Feature flags
  // Set to 'true' to route compliance queries through the agentic orchestrator
  // (router → grader → verifier). Default false — legacy grounded-query path is
  // the fallback when disabled or when the orchestrator throws.
  ORCHESTRATOR_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Cloudflare R2  -  public bucket (avatars, logos, branding)
  R2_PUBLIC_ACCESS_KEY_ID: z.string().min(1, 'R2 public bucket access key is required'),
  R2_PUBLIC_SECRET_ACCESS_KEY: z.string().min(1, 'R2 public bucket secret key is required'),
  R2_PUBLIC_BUCKET_NAME: z.string().min(1, 'R2 public bucket name is required'),
  R2_PUBLIC_BUCKET_URL: z.string().url('R2 public bucket URL must be a valid URL'),

  // Rate Limiting
  RATE_LIMIT_MAX: z.string().transform(Number).pipe(z.number().positive()).default(100),
  RATE_LIMIT_WINDOW: z.string().default('15m'),

  // Stripe
  STRIPE_SECRET_KEY: z.string().min(1, 'Stripe secret key is required'),
  STRIPE_PUBLISHABLE_KEY: z.string().min(1, 'Stripe publishable key is required'),
  STRIPE_WEBHOOK_SECRET: z.string().min(1, 'Stripe webhook secret is required'),

  // IntaSend (M-Pesa)  -  optional; required only when M-Pesa payment method is used
  INTASEND_PUBLISHABLE_KEY: z.string().optional().default(''),
  INTASEND_SECRET_KEY: z.string().optional().default(''),
  INTASEND_IS_TEST: z.string().optional().default('true'),
  INTASEND_WEBHOOK_CHALLENGE: z.string().optional().default(''),
  INTASEND_WEBHOOK_URL: z.string().optional().default(''),
  INTASEND_PLAN_STARTUP_MONTHLY: z.string().optional().default(''),
  INTASEND_PLAN_STARTUP_YEARLY: z.string().optional().default(''),
  INTASEND_PLAN_BUSINESS_MONTHLY: z.string().optional().default(''),
  INTASEND_PLAN_BUSINESS_YEARLY: z.string().optional().default(''),

  // Marketing & Outreach Module
  RESEND_MARKETING_FROM_EMAIL: z.string().email().default('marketing@sheriabot.com'),
  RESEND_MARKETING_FROM_NAME: z.string().min(1).default('SheriaBot'),
  RESEND_WEBHOOK_SECRET: z.string().min(32, 'RESEND_WEBHOOK_SECRET must be at least 32 chars'),
  MARKETING_TOKEN_HMAC_SECRET: z.string().min(64, 'MARKETING_TOKEN_HMAC_SECRET must be at least 64 chars'),
  APP_PUBLIC_URL: z.string().url(),
  ADMIN_NOTIFICATION_EMAIL: z.string().email().default('hello@sheriabot.com'),
  PILOT_INVITATION_EXPIRY_DAYS: z.coerce.number().int().min(1).max(90).default(14),
});

/**
 * Validate and parse environment variables
 * Throws detailed error if validation fails
 */
function validateEnv() {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingVars = error.issues.map((err) => `  - ${err.path.join('.')}: ${err.message}`);
      console.error('❌ Environment validation failed:\n' + missingVars.join('\n'));
      process.exit(1);
    }
    throw error;
  }
}

const env = validateEnv();

/**
 * Application configuration object
 * All app settings centralized and typed
 */
export const appConfig = {
  // Environment
  env: env.NODE_ENV,
  isDevelopment: env.NODE_ENV === 'development',
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  malwareScanEnabled: env.MALWARE_SCAN_ENABLED,

  // Feature flags
  features: {
    orchestratorEnabled: env.ORCHESTRATOR_ENABLED,
  },

  // Server
  port: env.PORT,
  appUrl: env.APP_URL,
  // The canonical (first) frontend URL  -  used in email links and redirects.
  // When FRONTEND_URL is comma-separated for multi-origin CORS, this is the primary domain.
  frontendUrl: env.FRONTEND_URL.split(',')[0].trim(),

  // Database
  database: {
    url: env.DATABASE_URL,
    directUrl: env.DIRECT_URL,
  },

  // Redis (Upstash)
  redis: {
    restUrl: env.UPSTASH_REDIS_REST_URL,
    restToken: env.UPSTASH_REDIS_REST_TOKEN,
  },

  // Supabase Auth
  supabase: {
    url: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    jwtSecret: env.SUPABASE_JWT_SECRET,
  },

  // Email
  email: {
    apiKey: env.RESEND_API_KEY,
    from: env.FROM_EMAIL,
    fromName: 'SheriaBot',
    supportRecipient: env.SUPPORT_EMAIL_RECIPIENT,
  },

  // AI
  ai: {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL,
  },

  // Vector Database
  pinecone: {
    apiKey: env.PINECONE_API_KEY,
    environment: env.PINECONE_ENVIRONMENT,
    indexName: env.PINECONE_INDEX_NAME,
  },

  // Storage  -  private bucket (RAG documents, vault files)
  storage: {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucketName: env.R2_BUCKET_NAME,
    publicUrl: env.R2_PUBLIC_URL,
  },

  // Public storage  -  public bucket (avatars, logos, branding assets)
  publicStorage: {
    accessKeyId: env.R2_PUBLIC_ACCESS_KEY_ID,
    secretAccessKey: env.R2_PUBLIC_SECRET_ACCESS_KEY,
    bucketName: env.R2_PUBLIC_BUCKET_NAME,
    // Endpoint is the same R2 account; only credentials + bucket differ
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    bucketUrl: env.R2_PUBLIC_BUCKET_URL,
  },

  // Rate Limiting
  rateLimit: {
    max: env.RATE_LIMIT_MAX,
    window: env.RATE_LIMIT_WINDOW,
  },

  // Stripe
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
  },

  // IntaSend (M-Pesa)
  intasend: {
    publishableKey: env.INTASEND_PUBLISHABLE_KEY,
    secretKey: env.INTASEND_SECRET_KEY,
    isTest: env.INTASEND_IS_TEST === 'true',
    webhookChallenge: env.INTASEND_WEBHOOK_CHALLENGE,
    webhookUrl: env.INTASEND_WEBHOOK_URL,
    subscriptionPlans: {
      STARTUP: {
        monthly: env.INTASEND_PLAN_STARTUP_MONTHLY,
        yearly: env.INTASEND_PLAN_STARTUP_YEARLY,
      },
      BUSINESS: {
        monthly: env.INTASEND_PLAN_BUSINESS_MONTHLY,
        yearly: env.INTASEND_PLAN_BUSINESS_YEARLY,
      },
    },
  },

  // Marketing & Outreach Module
  marketing: {
    fromEmail: env.RESEND_MARKETING_FROM_EMAIL,
    fromName: env.RESEND_MARKETING_FROM_NAME,
    webhookSecret: env.RESEND_WEBHOOK_SECRET,
    tokenHmacSecret: env.MARKETING_TOKEN_HMAC_SECRET,
    appPublicUrl: env.APP_PUBLIC_URL,
    adminNotificationEmail: env.ADMIN_NOTIFICATION_EMAIL,
    pilotInvitationExpiryDays: env.PILOT_INVITATION_EXPIRY_DAYS,
  },
} as const;

/**
 * Helper function to check if running in development
 */
export const isDevelopment = () => appConfig.isDevelopment;

/**
 * Helper function to check if running in production
 */
export const isProduction = () => appConfig.isProduction;

/**
 * Helper function to check if running in test mode
 */
export const isTest = () => appConfig.isTest;

/**
 * Export environment type for use in other modules
 */
export type AppConfig = typeof appConfig;

// Log configuration on startup (in development only)
if (isDevelopment()) {
  console.log('✅ Configuration loaded successfully');
  console.log(`📍 Environment: ${appConfig.env}`);
  console.log(`🌐 App URL: ${appConfig.appUrl}`);
  console.log(`🎨 Frontend URL: ${appConfig.frontendUrl}`);
}
