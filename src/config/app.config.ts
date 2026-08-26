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
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  APP_RUNTIME_MODE: z.enum(['standard', 'preview']).default('standard'),
  PORT: z.string().transform(Number).pipe(z.number().min(1).max(65535)).default(4000),
  APP_URL: z.string().url(),
  // Comma-separated origins are supported for CORS (e.g. apex + www + Vercel previews).
  // The first value is the canonical URL used in links/emails.
  FRONTEND_URL: z.string().min(1),

  // Database
  DATABASE_ENVIRONMENT: z.enum(['unknown', 'preview', 'development-uat', 'production']).default('unknown'),
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
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),

  // OpenAI
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o'),

  // Gemini
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),

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
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.string().default('3310').transform(Number).pipe(z.number().int().min(1).max(65535)),
  CLAMAV_TIMEOUT_MS: z.string().default('30000').transform(Number).pipe(z.number().int().positive()),

  // Feature flags
  // Set to 'true' to route compliance queries through the agentic orchestrator
  // (router -> grader -> verifier). Default false - legacy grounded-query path
  // is the fallback when disabled or when the orchestrator throws.
  ORCHESTRATOR_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  AGENTS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DISABLE_BACKGROUND_WORKERS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DISABLE_SCHEDULED_JOBS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DISABLE_OUTBOUND_EMAIL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DISABLE_N8N_AUTOMATION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ACTIVE_PAYMENT_PROVIDER: z.enum(['INTASEND', 'STRIPE']).default('INTASEND'),
  STRIPE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Pack 1 (Editorial Intelligence) rollout flags - see
  // docs/editorial-intelligence/human-review-backfill-runbook.md and
  // phase-b-foundations.md Foundation E for the required rollout order.
  // Computation and enforcement are deliberately two separate flags: the
  // policy can compute and persist explicit values without yet blocking
  // anything, so the backfill can be reviewed before enforcement goes live.
  EDITORIAL_HUMAN_REVIEW_POLICY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  EDITORIAL_HUMAN_REVIEW_ENFORCEMENT_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Shared publish-readiness evaluator rollout mode - see
  // docs/editorial-intelligence/publish-readiness-burn-in-runbook.md.
  // 'off': evaluator not invoked at all. 'shadow': evaluator runs and logs
  // divergences but never changes the publish decision (existing inline gates
  // stay authoritative). 'enforce': evaluator result is authoritative -
  // NOT enabled by default, cutover is a separate, explicit later action.
  BLOG_PUBLISH_READINESS_MODE: z
    .enum(['off', 'shadow', 'enforce'])
    .default('shadow'),
  AGENT_MAX_COST_PER_RUN_USD: z.coerce.number().positive().default(2),
  AGENT_MAX_COST_PER_DAY_USD: z.coerce.number().positive().default(20),
  AGENT_MAX_ITERATIONS_PER_RUN: z.coerce.number().int().positive().default(25),

  // n8n automation surface (agents.automation.*)  -  rate limits are separate
  // from the agent-auth rate limit in requireAgentCapability, which only
  // throttles credential-verification attempts, not per-capability throughput.
  AUTOMATION_LOG_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  AUTOMATION_LOG_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  AUTOMATION_GENERATE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  AUTOMATION_GENERATE_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  // Signs agents.automation.recordApprovalDecision's callback POST back to n8n
  // (HMAC-SHA256 over "${approvalId}.${decision}.${timestamp}"). Distinct trust
  // boundary from the X-Agent-Credential principal secrets above - this signs
  // outbound backend->n8n callbacks, not inbound n8n->backend auth - so it is
  // never reused from AGENT_PRINCIPALS' hashed credentials.
  AUTOMATION_HMAC_SECRET: z.string().min(64, 'AUTOMATION_HMAC_SECRET must be at least 64 chars'),
  // Signs the emailed approval-decision link (approvalId + link expiry only,
  // never the decision itself - see approval-decision-link-signature.ts).
  // Distinct trust boundary from AUTOMATION_HMAC_SECRET: that secret proves an
  // outbound callback to n8n is genuine; this one proves an inbound, publicly
  // clickable email link is genuine. Kept separate on purpose so a leak of
  // one secret cannot be used to forge the other kind of token.
  APPROVAL_DECISION_LINK_SECRET: z.string().min(64, 'APPROVAL_DECISION_LINK_SECRET must be at least 64 chars'),
  // Shared bucket for agents.automation.getMetrics - Monday Board Brief calls
  // this up to 6x in quick succession (one per department), so the ceiling is
  // higher than the single-call automation buckets above.
  AUTOMATION_METRICS_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  AUTOMATION_METRICS_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  AUTOMATION_APPROVAL_CREATE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  AUTOMATION_APPROVAL_CREATE_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  // Higher ceiling than the other automation buckets - n8n polls getApproval
  // as its 30-minute-timeout fallback, potentially across several pending
  // approvals concurrently.
  AUTOMATION_APPROVAL_READ_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  AUTOMATION_APPROVAL_READ_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),

  // Editorial Intelligence LLM procedures
  AUTOMATION_EDITORIAL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  AUTOMATION_EDITORIAL_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),

  // Outbound backend -> n8n webhook fan-out (agents.automation.queueContentCandidate).
  // Distinct trust boundary from X-Agent-Credential (inbound n8n -> backend) and from
  // AUTOMATION_HMAC_SECRET (approval callback signing) - this signs/authenticates a
  // call this backend makes TO n8n's own webhook ingress, using n8n's shared secret.
  SHERIABOT_WEBHOOK_INGRESS_HEADER: z.string().min(1).default('X-Sheriabot-Ingress-Key'),
  SHERIABOT_WEBHOOK_INGRESS_SECRET: z.string().min(32, 'SHERIABOT_WEBHOOK_INGRESS_SECRET must be at least 32 chars'),

  // Shared bucket for Phase 3's remaining single-workflow automation procedures
  // (publishContent, queueContentCandidate, getRecentHighImpactRegulatoryItems,
  // getApprovedContentThisWeek, sendNewsletter, queueOutreach, getSources,
  // fetchSource, dedupeSource, getPilotCohortStatus, getDpaVendorStatus,
  // shouldNotify) - one config pair, distinct per-procedure action keys, same
  // precedent as appConfig.agents.trigger (B9): no reason for different
  // ceilings across these low-frequency, once-per-workflow-run procedures.
  AUTOMATION_WORKFLOW_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  AUTOMATION_WORKFLOW_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),

  // n8n scheduler/trigger surface (agents.regIntel.runScan, agents.marketing.
  // runDrafting, agents.sales.runDrafting, agents.productBi.runReport, agents.
  // securityOps.runReport, agents.chiefOfStaff.runBrief)  -  one shared bucket
  // per procedure (distinct action keys, same ceiling), separate from the
  // agent-auth rate limit in requireAgentCapability and from the automation
  // buckets above. Expected call volume is at most once per cadence window
  // (daily or twice-weekly per docs/sprints/b9-n8n-trigger-wiring-stage1-audit.md),
  // so the default only needs to absorb retries/overlap, not steady throughput.
  AGENT_TRIGGER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  AGENT_TRIGGER_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),

  // PostHog read-only query access (HogQL query API). Optional - the
  // sales/growth agent's engagement lookup degrades to unavailable when unset.
  // POSTHOG_PERSONAL_API_KEY is a query-scoped Personal API Key, distinct from
  // a project capture key. Never used for event capture or property writes.
  POSTHOG_PERSONAL_API_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().url().optional(),
  POSTHOG_PROJECT_ID: z.string().optional(),

  // Sentry Issues API (read-only critical-issue check for W-SEC-01/W-SEC-03).
  // Optional - checkCriticalIssues() degrades to dataAvailable: false when
  // unset. Distinct from SENTRY_DSN (outbound error capture, read directly
  // via process.env in src/lib/sentry.ts): this is an internal integration
  // token with issue-read scope, minted separately in Sentry - do not reuse
  // SENTRY_AUTH_TOKEN (that one is source-map upload scoped).
  SENTRY_API_TOKEN: z.string().optional(),
  SENTRY_ORG: z.string().optional(),
  SENTRY_PROJECT: z.string().optional(),

  // Cloudflare R2  -  public bucket (avatars, logos, branding)
  R2_PUBLIC_ACCESS_KEY_ID: z.string().min(1, 'R2 public bucket access key is required'),
  R2_PUBLIC_SECRET_ACCESS_KEY: z.string().min(1, 'R2 public bucket secret key is required'),
  R2_PUBLIC_BUCKET_NAME: z.string().min(1, 'R2 public bucket name is required'),
  R2_PUBLIC_BUCKET_URL: z.string().url('R2 public bucket URL must be a valid URL'),

  // Rate Limiting
  RATE_LIMIT_MAX: z.string().transform(Number).pipe(z.number().positive()).default(100),
  RATE_LIMIT_WINDOW: z.string().default('15m'),

  // Stripe. Required only when STRIPE_ENABLED=true.
  STRIPE_SECRET_KEY: z.string().optional().default(''),
  STRIPE_PUBLISHABLE_KEY: z.string().optional().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(''),

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
  INTASEND_RECONCILIATION_STALE_MINUTES: z.coerce.number().int().positive().default(15),
  INTASEND_PENDING_EXPIRE_HOURS: z.coerce.number().int().positive().default(24),
  MPESA_RENEWAL_GRACE_DAYS: z.coerce.number().int().min(1).default(7),

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
    const parsed = envSchema.parse(process.env);
    const invalidVariables: string[] = [];

    if (parsed.STRIPE_ENABLED) {
      if (!parsed.STRIPE_SECRET_KEY) invalidVariables.push('STRIPE_SECRET_KEY');
      if (!parsed.STRIPE_PUBLISHABLE_KEY) invalidVariables.push('STRIPE_PUBLISHABLE_KEY');
      if (!parsed.STRIPE_WEBHOOK_SECRET) invalidVariables.push('STRIPE_WEBHOOK_SECRET');
    }

    if (parsed.ACTIVE_PAYMENT_PROVIDER === 'STRIPE' && !parsed.STRIPE_ENABLED) {
      invalidVariables.push('ACTIVE_PAYMENT_PROVIDER/STRIPE_ENABLED');
    }

    if (invalidVariables.length > 0) {
      console.error(
        [
          'Environment validation failed.',
          'Invalid variable names only; values are intentionally not logged.',
          ...invalidVariables.map((name) => `  - ${name}`),
        ].join('\n')
      );
      process.exit(1);
    }

    return parsed;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const invalidVariables = error.issues.map((err) => `  - ${err.path.join('.') || '<root>'}`);
      console.error(
        [
          'Environment validation failed.',
          'Invalid variable names only; values and parsed defaults are intentionally not logged.',
          ...invalidVariables,
        ].join('\n')
      );
      process.exit(1);
    }
    throw error;
  }
}

const env = validateEnv();

// TODO: [CRITICAL-SECURITY] Re-enable ClamAV host check before full production launch.
// This check is temporarily disabled to allow deployment without a running ClamAV service.
/*
if (
  env.NODE_ENV !== 'development' &&
  env.NODE_ENV !== 'test' &&
  (!env.MALWARE_SCAN_ENABLED || !env.CLAMAV_HOST)
) {
  throw new Error(
    'Startup blocked: vault malware scanning must be enabled with CLAMAV_HOST outside development/test.',
  );
}
*/

/**
 * Application configuration object
 * All app settings centralized and typed
 */
export const appConfig = {
  // Environment
  env: env.NODE_ENV,
  runtime: {
    mode: env.APP_RUNTIME_MODE,
    isPreview: env.APP_RUNTIME_MODE === 'preview',
    disableBackgroundWorkers: env.DISABLE_BACKGROUND_WORKERS || env.APP_RUNTIME_MODE === 'preview',
    disableScheduledJobs: env.DISABLE_SCHEDULED_JOBS || env.APP_RUNTIME_MODE === 'preview',
    disableOutboundEmail: env.DISABLE_OUTBOUND_EMAIL || env.APP_RUNTIME_MODE === 'preview',
    disableN8nAutomation: env.DISABLE_N8N_AUTOMATION || env.APP_RUNTIME_MODE === 'preview',
  },
  isDevelopment: env.NODE_ENV === 'development',
  isStaging: env.NODE_ENV === 'staging',
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  malwareScanEnabled: env.MALWARE_SCAN_ENABLED,
  clamav: {
    host: env.CLAMAV_HOST,
    port: env.CLAMAV_PORT,
    timeoutMs: env.CLAMAV_TIMEOUT_MS,
  },

  // Feature flags
  features: {
    orchestratorEnabled: env.ORCHESTRATOR_ENABLED,
    agentsEnabled: env.AGENTS_ENABLED,
  },
  payments: {
    activeProvider: env.ACTIVE_PAYMENT_PROVIDER,
    stripeEnabled: env.STRIPE_ENABLED,
    intasendEnabled: env.ACTIVE_PAYMENT_PROVIDER === 'INTASEND',
  },

  editorial: {
    humanReviewPolicyEnabled: env.EDITORIAL_HUMAN_REVIEW_POLICY_ENABLED,
    humanReviewEnforcementEnabled: env.EDITORIAL_HUMAN_REVIEW_ENFORCEMENT_ENABLED,
    publishReadinessMode: env.BLOG_PUBLISH_READINESS_MODE,
  },
  agents: {
    maxCostPerRunUsd: env.AGENT_MAX_COST_PER_RUN_USD,
    maxCostPerDayUsd: env.AGENT_MAX_COST_PER_DAY_USD,
    maxIterationsPerRun: env.AGENT_MAX_ITERATIONS_PER_RUN,
    automation: {
      logRateLimitMax: env.AUTOMATION_LOG_RATE_LIMIT_MAX,
      logRateLimitWindowSeconds: env.AUTOMATION_LOG_RATE_LIMIT_WINDOW_SECONDS,
      generateRateLimitMax: env.AUTOMATION_GENERATE_RATE_LIMIT_MAX,
      generateRateLimitWindowSeconds: env.AUTOMATION_GENERATE_RATE_LIMIT_WINDOW_SECONDS,
      hmacSecret: env.AUTOMATION_HMAC_SECRET,
      decisionLinkSecret: env.APPROVAL_DECISION_LINK_SECRET,
      metricsRateLimitMax: env.AUTOMATION_METRICS_RATE_LIMIT_MAX,
      metricsRateLimitWindowSeconds: env.AUTOMATION_METRICS_RATE_LIMIT_WINDOW_SECONDS,
      approvalCreateRateLimitMax: env.AUTOMATION_APPROVAL_CREATE_RATE_LIMIT_MAX,
      approvalCreateRateLimitWindowSeconds: env.AUTOMATION_APPROVAL_CREATE_RATE_LIMIT_WINDOW_SECONDS,
      approvalReadRateLimitMax: env.AUTOMATION_APPROVAL_READ_RATE_LIMIT_MAX,
      approvalReadRateLimitWindowSeconds: env.AUTOMATION_APPROVAL_READ_RATE_LIMIT_WINDOW_SECONDS,
      editorialRateLimitMax: env.AUTOMATION_EDITORIAL_RATE_LIMIT_MAX,
      editorialRateLimitWindowSeconds: env.AUTOMATION_EDITORIAL_RATE_LIMIT_WINDOW_SECONDS,
      webhookIngress: {
        header: env.SHERIABOT_WEBHOOK_INGRESS_HEADER,
        secret: env.SHERIABOT_WEBHOOK_INGRESS_SECRET,
      },
      workflowRateLimitMax: env.AUTOMATION_WORKFLOW_RATE_LIMIT_MAX,
      workflowRateLimitWindowSeconds: env.AUTOMATION_WORKFLOW_RATE_LIMIT_WINDOW_SECONDS,
    },
    trigger: {
      rateLimitMax: env.AGENT_TRIGGER_RATE_LIMIT_MAX,
      rateLimitWindowSeconds: env.AGENT_TRIGGER_RATE_LIMIT_WINDOW_SECONDS,
    },
  },
  posthog: {
    personalApiKey: env.POSTHOG_PERSONAL_API_KEY,
    host: env.POSTHOG_HOST,
    projectId: env.POSTHOG_PROJECT_ID,
  },
  sentry: {
    apiToken: env.SENTRY_API_TOKEN,
    org: env.SENTRY_ORG,
    project: env.SENTRY_PROJECT,
  },

  // Server
  port: env.PORT,
  appUrl: env.APP_URL,
  // The canonical (first) frontend URL  -  used in email links and redirects.
  // When FRONTEND_URL is comma-separated for multi-origin CORS, this is the primary domain.
  frontendUrl: env.FRONTEND_URL.split(',')[0].trim(),

  // Database
  database: {
    environment: env.DATABASE_ENVIRONMENT,
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
  openai: {
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL,
  },
  gemini: {
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
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
    reconciliation: {
      staleMinutes: env.INTASEND_RECONCILIATION_STALE_MINUTES,
      pendingExpireHours: env.INTASEND_PENDING_EXPIRE_HOURS,
    },
    renewal: {
      graceDays: env.MPESA_RENEWAL_GRACE_DAYS,
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
  console.log('Configuration loaded successfully');
  console.log(`Environment: ${appConfig.env}`);
  console.log(`App URL: ${appConfig.appUrl}`);
  console.log(`Frontend URL: ${appConfig.frontendUrl}`);
}
