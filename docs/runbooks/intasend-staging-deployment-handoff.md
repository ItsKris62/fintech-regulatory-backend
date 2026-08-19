# IntaSend Staging Deployment Handoff

This handoff is for manual staging deployment only. Do not deploy production, do not modify production secrets, and do not copy production database credentials into staging.

## Release Coordinates

- Backend service name: `sheriabot-backend-staging`
- Backend repository directory: `fintech-regulatory-backend`
- Backend branch: `staging/intasend-billing`
- Original IntaSend billing remediation SHA: `290546bc2940f79c592c2f195398d88150165217`
- Post-security-remediation staging SHA: `3e59c196d3983fc0a2f36ad3f8ba3e26f1bb7754`
- Database: Development-UAT only
- Production database: do not use

## Render Service

- Service type: Web Service
- Runtime: Node
- Region from current `render.yaml`: `oregon`
- Plan from current `render.yaml`: `starter`
- Required working directory: repository root for `fintech-regulatory-backend`
- Health endpoint: `/health`
- Port handling: app reads `PORT`; current Render config sets `PORT=4000`

## Build and Start Contract

- Build command from `render.yaml`: `npm ci && npm run build:prod`
- Production build script: `tsc -p tsconfig.prod.json && tsc-alias -p tsconfig.prod.json`
- Start command from `render.yaml`: `npm run start:prod`
- Start script: `node dist/index.js`
- Migration lifecycle: `prestart:prod` runs `npm run db:migrate:prod`
- Migration command: `prisma migrate deploy`
- Node version from `render.yaml`: `20.20.0`

The current package contract runs migrations before `start:prod`. If Render pre-deploy commands are used instead, do not run migrations twice; keep one explicit migration path and confirm against Development-UAT.

## Required Environment Variables

Set values in Render for the staging service only. Do not place values in docs, commits, screenshots, or chat.

### Runtime

- `NODE_ENV=staging`
- `NODE_VERSION=20.20.0`
- `PORT=4000`
- `LOG_LEVEL`
- `APP_RUNTIME_MODE`
- `DATABASE_ENVIRONMENT=development-uat`
- `APP_URL`
- `FRONTEND_URL`
- `APP_PUBLIC_URL`

### Payment

- `ACTIVE_PAYMENT_PROVIDER=INTASEND`
- `STRIPE_ENABLED=false`
- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_STARTUP_MONTHLY`
- `STRIPE_PRICE_BUSINESS_MONTHLY`

Keep Stripe disabled in staging for IntaSend UAT. Stripe variables may be blank unless validation or dormant-path tests require placeholders.

### IntaSend

- `INTASEND_PUBLISHABLE_KEY`
- `INTASEND_SECRET_KEY`
- `INTASEND_IS_TEST`
- `INTASEND_WEBHOOK_CHALLENGE`
- `INTASEND_WEBHOOK_URL`
- `INTASEND_WEBHOOK_ALLOWED_IPS`
- `INTASEND_PLAN_STARTUP_MONTHLY`
- `INTASEND_PLAN_STARTUP_YEARLY`
- `INTASEND_PLAN_BUSINESS_MONTHLY`
- `INTASEND_PLAN_BUSINESS_YEARLY`
- `INTASEND_RECONCILIATION_STALE_MINUTES`
- `INTASEND_PENDING_EXPIRE_HOURS`
- `MPESA_RENEWAL_GRACE_DAYS`

Webhook URL after deployment:

```text
https://<sheriabot-backend-staging-render-host>/api/webhooks/intasend
```

### Database

- `DATABASE_URL`
- `DIRECT_URL`

Both must point to Development-UAT Supabase/Postgres only.

### Redis

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

### Supabase

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_JWT_SECRET`

### Email

- `RESEND_API_KEY`
- `FROM_EMAIL`
- `SUPPORT_EMAIL_RECIPIENT`
- `RESEND_MARKETING_FROM_EMAIL`
- `RESEND_MARKETING_FROM_NAME`
- `RESEND_WEBHOOK_SECRET`
- `MARKETING_TOKEN_HMAC_SECRET`
- `ADMIN_NOTIFICATION_EMAIL`

### Storage

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_PUBLIC_URL`
- `R2_PUBLIC_ACCESS_KEY_ID`
- `R2_PUBLIC_SECRET_ACCESS_KEY`
- `R2_PUBLIC_BUCKET_NAME`
- `R2_PUBLIC_BUCKET_URL`
- `R2_VAULT_BUCKET`
- `R2_VAULT_ENDPOINT`
- `R2_VAULT_ACCESS_KEY_ID`
- `R2_VAULT_SECRET_ACCESS_KEY`

### AI and Search Dependencies

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `PINECONE_API_KEY`
- `PINECONE_ENVIRONMENT`
- `PINECONE_INDEX_NAME`

### Automation and Operations

- `AUTOMATION_HMAC_SECRET`
- `APPROVAL_DECISION_LINK_SECRET`
- `SHERIABOT_WEBHOOK_INGRESS_HEADER`
- `SHERIABOT_WEBHOOK_INGRESS_SECRET`
- `AUTOMATION_LOG_RATE_LIMIT_MAX`
- `AUTOMATION_LOG_RATE_LIMIT_WINDOW_SECONDS`
- `AUTOMATION_GENERATE_RATE_LIMIT_MAX`
- `AUTOMATION_GENERATE_RATE_LIMIT_WINDOW_SECONDS`
- `AUTOMATION_METRICS_RATE_LIMIT_MAX`
- `AUTOMATION_METRICS_RATE_LIMIT_WINDOW_SECONDS`
- `AUTOMATION_APPROVAL_CREATE_RATE_LIMIT_MAX`
- `AUTOMATION_APPROVAL_CREATE_RATE_LIMIT_WINDOW_SECONDS`
- `AUTOMATION_APPROVAL_READ_RATE_LIMIT_MAX`
- `AUTOMATION_APPROVAL_READ_RATE_LIMIT_WINDOW_SECONDS`
- `AUTOMATION_EDITORIAL_RATE_LIMIT_MAX`
- `AUTOMATION_EDITORIAL_RATE_LIMIT_WINDOW_SECONDS`
- `AUTOMATION_WORKFLOW_RATE_LIMIT_MAX`
- `AUTOMATION_WORKFLOW_RATE_LIMIT_WINDOW_SECONDS`
- `AGENT_TRIGGER_RATE_LIMIT_MAX`
- `AGENT_TRIGGER_RATE_LIMIT_WINDOW_SECONDS`
- `POSTHOG_PERSONAL_API_KEY`
- `POSTHOG_HOST`
- `POSTHOG_PROJECT_ID`
- `SENTRY_API_TOKEN`
- `SENTRY_ORG`
- `SENTRY_PROJECT`
- `SENTRY_DSN`
- `SENTRY_TRACES_SAMPLE_RATE`

### Feature and Safety Flags

- `ORCHESTRATOR_ENABLED`
- `AGENTS_ENABLED`
- `DISABLE_BACKGROUND_WORKERS`
- `DISABLE_SCHEDULED_JOBS`
- `DISABLE_OUTBOUND_EMAIL`
- `DISABLE_N8N_AUTOMATION`
- `EDITORIAL_HUMAN_REVIEW_POLICY_ENABLED`
- `EDITORIAL_HUMAN_REVIEW_ENFORCEMENT_ENABLED`
- `BLOG_PUBLISH_READINESS_MODE`
- `AGENT_MAX_COST_PER_RUN_USD`
- `AGENT_MAX_COST_PER_DAY_USD`
- `AGENT_MAX_ITERATIONS_PER_RUN`
- `RATE_LIMIT_MAX`
- `RATE_LIMIT_WINDOW`
- `MALWARE_SCAN_ENABLED`
- `CLAMAV_HOST`
- `CLAMAV_PORT`
- `CLAMAV_TIMEOUT_MS`
- `PILOT_INVITATION_EXPIRY_DAYS`

### Proxy

- `TRUST_PROXY_HOPS=TO BE DETERMINED FROM STAGING PROXY TEST`
- `TRUST_PROXY`

Do not set a production value for `TRUST_PROXY_HOPS` until T1 captures Render runtime evidence. Start with proxy trust disabled or blank for diagnostics, then update staging only after the spoof tests identify the safe hop count.

## First Health Check

After Render reports the deployment live:

1. Open `https://<staging-host>/health`.
2. Confirm HTTP 200 and no secret values in logs.
3. Confirm logs show staging env names only, not credential values.
4. Record deployed SHA and health response timestamp.

## Cron Jobs

Create these as Render Cron Jobs in staging only. Reuse staging env safely.

### IntaSend Reconciliation

- Name: `sheriabot-staging-intasend-reconciliation`
- Command: `npm run billing:intasend:reconcile`
- Schedule: `*/15 * * * *`
- Timezone: Render cron schedules are UTC.
- Purpose: repair stale pending IntaSend payments when webhooks were missed.
- Required env: database, Redis, IntaSend, payment flags, app runtime flags.

### M-Pesa Renewal Lifecycle

- Name: `sheriabot-staging-mpesa-renewals`
- Command: `npm run billing:mpesa:renewals`
- Schedule: `0 6 * * *`
- Timezone: Render cron schedules are UTC.
- Local time: `06:00 UTC = 09:00 Africa/Nairobi`.
- Required env: database, Redis, email, frontend URL, payment flags, renewal grace settings.

THE RENEWAL CRON MUST NOT INITIATE UNSOLICITED STK PUSHES.

## Manual Deployment Sequence

1. Create the Render staging service `sheriabot-backend-staging`.
2. Connect branch `staging/intasend-billing` at SHA `3e59c196d3983fc0a2f36ad3f8ba3e26f1bb7754`.
3. Set all staging environment variables, using Development-UAT database values only.
4. Deploy and wait for Render status `Live`.
5. Run `/health`.
6. Complete T1 proxy diagnostics before configuring IntaSend webhook allowlisting.
7. Configure IntaSend sandbox/test webhook URL.
8. Create staging cron jobs only after backend health and T1 are complete.
