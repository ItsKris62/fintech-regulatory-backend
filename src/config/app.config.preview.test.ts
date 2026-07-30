import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

function applyBaseEnv(overrides: NodeJS.ProcessEnv = {}): void {
  process.env = {
    ...originalEnv,
    NODE_ENV: 'production',
    APP_RUNTIME_MODE: 'standard',
    PORT: '4000',
    APP_URL: 'https://api.example.test',
    FRONTEND_URL: 'https://app.example.test',
    DATABASE_URL: 'postgresql://user:password@preview-db.example.test:5432/postgres',
    UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
    UPSTASH_REDIS_REST_TOKEN: 'redis-token',
    SUPABASE_URL: 'https://supabase.example.test',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_JWT_SECRET: 'x'.repeat(32),
    RESEND_API_KEY: 're_test_key',
    FROM_EMAIL: 'noreply@example.test',
    ANTHROPIC_API_KEY: 'sk-ant-test-key',
    PINECONE_API_KEY: 'pinecone-key',
    R2_ACCOUNT_ID: 'r2-account',
    R2_ACCESS_KEY_ID: 'r2-access-key',
    R2_SECRET_ACCESS_KEY: 'r2-secret-key',
    R2_PUBLIC_URL: 'https://r2.example.test',
    AUTOMATION_HMAC_SECRET: 'a'.repeat(64),
    APPROVAL_DECISION_LINK_SECRET: 'b'.repeat(64),
    SHERIABOT_WEBHOOK_INGRESS_SECRET: 'c'.repeat(32),
    R2_PUBLIC_ACCESS_KEY_ID: 'r2-public-access-key',
    R2_PUBLIC_SECRET_ACCESS_KEY: 'r2-public-secret-key',
    R2_PUBLIC_BUCKET_NAME: 'public-assets',
    R2_PUBLIC_BUCKET_URL: 'https://assets.example.test',
    STRIPE_SECRET_KEY: 'sk_test_placeholder',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_placeholder',
    STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
    RESEND_WEBHOOK_SECRET: 'd'.repeat(32),
    MARKETING_TOKEN_HMAC_SECRET: 'e'.repeat(64),
    APP_PUBLIC_URL: 'https://app.example.test',
    ...overrides,
  };
}

async function loadAppConfig() {
  vi.resetModules();
  return import('./app.config');
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe('preview runtime side-effect controls', () => {
  it('keeps production defaults enabled in standard runtime', async () => {
    applyBaseEnv();

    const { appConfig } = await loadAppConfig();

    expect(appConfig.runtime).toMatchObject({
      mode: 'standard',
      isPreview: false,
      disableBackgroundWorkers: false,
      disableScheduledJobs: false,
      disableOutboundEmail: false,
      disableN8nAutomation: false,
    });
  });

  it('disables side-effect surfaces when APP_RUNTIME_MODE=preview', async () => {
    applyBaseEnv({ APP_RUNTIME_MODE: 'preview' });

    const { appConfig } = await loadAppConfig();

    expect(appConfig.runtime).toMatchObject({
      mode: 'preview',
      isPreview: true,
      disableBackgroundWorkers: true,
      disableScheduledJobs: true,
      disableOutboundEmail: true,
      disableN8nAutomation: true,
    });
  });

  it('allows explicit disable flags without changing runtime mode', async () => {
    applyBaseEnv({
      DISABLE_BACKGROUND_WORKERS: 'true',
      DISABLE_SCHEDULED_JOBS: 'true',
      DISABLE_OUTBOUND_EMAIL: 'true',
      DISABLE_N8N_AUTOMATION: 'true',
    });

    const { appConfig } = await loadAppConfig();

    expect(appConfig.runtime).toMatchObject({
      mode: 'standard',
      isPreview: false,
      disableBackgroundWorkers: true,
      disableScheduledJobs: true,
      disableOutboundEmail: true,
      disableN8nAutomation: true,
    });
  });
});
