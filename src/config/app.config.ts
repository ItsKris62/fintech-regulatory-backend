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
  FRONTEND_URL: z.string().url(),

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

  // Cloudflare R2
  R2_ACCOUNT_ID: z.string().min(1, 'R2 account ID is required'),
  R2_ACCESS_KEY_ID: z.string().min(1, 'R2 access key ID is required'),
  R2_SECRET_ACCESS_KEY: z.string().min(1, 'R2 secret access key is required'),
  R2_BUCKET_NAME: z.string().default('sheriabot-documents'),
  R2_PUBLIC_URL: z.string().url(),

  // Rate Limiting
  RATE_LIMIT_MAX: z.string().transform(Number).pipe(z.number().positive()).default(100),
  RATE_LIMIT_WINDOW: z.string().default('15m'),

  // Stripe
  STRIPE_SECRET_KEY: z.string().min(1, 'Stripe secret key is required'),
  STRIPE_PUBLISHABLE_KEY: z.string().min(1, 'Stripe publishable key is required'),
  STRIPE_WEBHOOK_SECRET: z.string().min(1, 'Stripe webhook secret is required'),
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

  // Server
  port: env.PORT,
  appUrl: env.APP_URL,
  frontendUrl: env.FRONTEND_URL,

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

  // Storage
  storage: {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucketName: env.R2_BUCKET_NAME,
    publicUrl: env.R2_PUBLIC_URL,
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