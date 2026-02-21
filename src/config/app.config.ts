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

  // Redis
  REDIS_URL: z.string().min(1, 'Redis URL is required'),

  // JWT
  JWT_SECRET: z.string().min(32, 'JWT secret must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  REFRESH_TOKEN_SECRET: z.string().min(32, 'Refresh token secret must be at least 32 characters'),
  REFRESH_TOKEN_EXPIRES_IN: z.string().default('30d'),

  // Email
  RESEND_API_KEY: z.string().startsWith('re_', 'Invalid Resend API key'),
  FROM_EMAIL: z.string().email(),

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
  },

  // Redis
  redis: {
    url: env.REDIS_URL,
  },

  // JWT
  jwt: {
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
    refreshSecret: env.REFRESH_TOKEN_SECRET,
    refreshExpiresIn: env.REFRESH_TOKEN_EXPIRES_IN,
  },

  // Email
  email: {
    apiKey: env.RESEND_API_KEY,
    from: env.FROM_EMAIL,
    fromName: 'SheriaBot',
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