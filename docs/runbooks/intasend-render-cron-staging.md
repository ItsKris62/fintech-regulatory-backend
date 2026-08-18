# IntaSend Render Cron Staging Configuration

Render Cron Jobs use standard cron expressions evaluated in UTC and should run
commands that exit after completion. Render also guarantees at most one active
run for a single cron job; if a scheduled run arrives while the prior run is
still active, the next run is delayed.

## IntaSend Reconciliation

- Name: `sheriabot-staging-intasend-reconciliation`
- Command: `npm run billing:intasend:reconcile`
- Schedule: `*/15 * * * *`
- Timezone behavior: UTC. This runs every 15 minutes UTC.
- Purpose: repair missed IntaSend webhooks for stale pending M-Pesa payments.
- Required environment:
  - `DATABASE_ENVIRONMENT=development-uat` or `preview` for staging
  - `DATABASE_URL`
  - `UPSTASH_REDIS_REST_URL`
  - `UPSTASH_REDIS_REST_TOKEN`
  - `ACTIVE_PAYMENT_PROVIDER=INTASEND`
  - `STRIPE_ENABLED=false`
  - `INTASEND_PUBLISHABLE_KEY`
  - `INTASEND_SECRET_KEY`
  - `INTASEND_IS_TEST=true`
  - `INTASEND_RECONCILIATION_STALE_MINUTES`
  - `INTASEND_PENDING_EXPIRE_HOURS`
- Concurrency policy: rely on Render single-run guarantee plus the Redis lock
  `sheriabot:cron:intasend-reconciliation:lock`.
- Expected logging:
  - `intasend_reconciliation_cron_start`
  - `intasend_reconciliation_complete`
  - `intasend_reconciliation_cron_complete`
  - `intasend_reconciliation_cron_fatal` on fatal failure
- Safe failure behavior: exceptions for one payment are counted and audited;
  the batch continues.

## M-Pesa Renewal Lifecycle

- Name: `sheriabot-staging-mpesa-renewals`
- Command: `npm run billing:mpesa:renewals`
- Schedule: `0 6 * * *`
- Timezone behavior: UTC. This runs daily at 09:00 Africa/Nairobi.
- Purpose: renewal reminders, past-due transitions, grace expiry, and downgrade
  lifecycle processing. It must not initiate unsolicited STK pushes.
- Required environment:
  - `DATABASE_ENVIRONMENT=development-uat` or `preview` for staging
  - `DATABASE_URL`
  - `UPSTASH_REDIS_REST_URL`
  - `UPSTASH_REDIS_REST_TOKEN`
  - `ACTIVE_PAYMENT_PROVIDER=INTASEND`
  - `STRIPE_ENABLED=false`
  - `RESEND_API_KEY`
  - `FROM_EMAIL`
  - `FRONTEND_URL`
  - `MPESA_RENEWAL_GRACE_DAYS`
- Concurrency policy: rely on Render single-run guarantee plus the Redis lock
  `sheriabot:cron:mpesa-renewals:lock`.
- Expected logging:
  - `mpesa_renewal_cron_start`
  - `mpesa_renewal_complete`
  - `mpesa_renewal_cron_complete`
  - `mpesa_renewal_cron_fatal` on fatal failure
- Safe failure behavior: exceptions for one organization are counted and logged;
  the batch continues.

