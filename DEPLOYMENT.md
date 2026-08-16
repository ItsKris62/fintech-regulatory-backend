# SheriaBot API - Render Deployment Guide

The production backend runs on Render. The frontend runs separately on Vercel and calls this API through the configured backend URL.

## Prerequisites

- Render account with access to the SheriaBot backend service
- GitHub repository connected to Render
- Supabase PostgreSQL database URL and direct migration URL
- Upstash Redis REST URL and token
- Pinecone, Cloudflare R2, Resend, Anthropic, Stripe, and Supabase secrets ready
- Vercel frontend URL ready for CORS

## Render Service

Use the checked-in `render.yaml` blueprint for the backend web service:

```yaml
services:
  - type: web
    name: fintech-regulatory-backend
    env: node
    buildCommand: npm ci && npm run build:prod
    startCommand: npm run start:prod
    healthCheckPath: /health
```

Recommended dashboard settings:

- Runtime: Node
- Auto-deploy: enabled for the production branch
- Health check path: `/health`
- Build command: `npm ci && npm run build:prod`
- Start command: `npm run start:prod`

The start command runs `prestart:prod`, which applies Prisma migrations with `prisma migrate deploy` before starting `dist/index.js`.

## Environment Variables

Set variables in Render dashboard under **Service -> Environment**. Use `.env.example` as the full reference list.

Required production values include:

```bash
NODE_ENV=production
PORT=4000
LOG_LEVEL=info

APP_URL=https://your-render-backend.onrender.com
FRONTEND_URL=https://your-vercel-frontend.vercel.app

DATABASE_ENVIRONMENT=production
DATABASE_URL=postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres

UPSTASH_REDIS_REST_URL=https://your-database.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-upstash-token

SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_JWT_SECRET=your-jwt-secret

ANTHROPIC_API_KEY=sk-ant-...
PINECONE_API_KEY=...
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
RESEND_API_KEY=re_...
STRIPE_SECRET_KEY=...
```

## Frontend on Vercel

The frontend is deployed from the separate `fintech-regulatory-platform` project on Vercel.

Set the frontend API variables to the Render backend URL:

```bash
NEXT_PUBLIC_API_URL=https://your-render-backend.onrender.com
NEXT_PUBLIC_TRPC_URL=https://your-render-backend.onrender.com/trpc
```

Set backend `FRONTEND_URL` to the production Vercel URL. Add preview origins as comma-separated values when Vercel previews need backend access:

```bash
FRONTEND_URL=https://app.sheriabot.com,https://your-preview.vercel.app
```

## Deploy

### Auto-deploy

Connect the backend repository in Render and enable auto-deploy for the production branch. A push to that branch triggers:

1. `npm ci`
2. `npm run build:prod`
3. `npm run start:prod`
4. `npm run db:migrate:prod` through the `prestart:prod` lifecycle script

### Manual deploy

Use Render dashboard:

1. Open the backend web service
2. Go to **Manual Deploy**
3. Choose **Deploy latest commit**

If you use a Render deploy hook, call it from your terminal or CI:

```bash
curl -X POST "$RENDER_DEPLOY_HOOK_URL"
```

## Verify Deployment

```bash
curl https://your-render-backend.onrender.com/health
curl https://your-render-backend.onrender.com/health/detailed
curl https://your-render-backend.onrender.com/
```

Expected:

- `/health` returns a healthy HTTP status
- `/health/detailed` can reach PostgreSQL and reports Redis status
- Vercel frontend can call `/trpc` and `/api/compliance/stream`

## Logs and Monitoring

- Render logs: **Service -> Logs**
- Render deploy history: **Service -> Deploys**
- Render metrics: **Service -> Metrics**
- Application structured logs include request IDs, health events, RAG errors, and service failures

For incidents:

1. Check the latest Render deploy logs
2. Check `/health/detailed`
3. Verify Supabase and Upstash service status
4. Confirm `APP_URL` and `FRONTEND_URL` are correct
5. Roll back to the last healthy Render deploy if the new deploy is bad

## Rollback

Use Render dashboard:

1. Open the backend service
2. Go to **Deploys**
3. Select the last known good deploy
4. Click **Rollback**

The Vercel frontend rolls back separately from the Vercel project dashboard.

## Troubleshooting

| Error | Likely Cause | Fix |
| ----- | ------------ | --- |
| `npm ci` fails | `package-lock.json` out of sync | Run `npm install`, commit the updated lockfile, redeploy |
| `prisma migrate deploy` fails | Migration or database drift | Inspect Render logs and run migrations only after confirming the target DB |
| `DATABASE_URL` connection errors | Wrong Supabase pooled URL or credentials | Verify `DATABASE_URL`, `DIRECT_URL`, and Supabase status |
| Redis degraded | Upstash REST URL/token missing or wrong | Verify `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` |
| CORS errors from Vercel | Frontend URL not allowed | Add production and preview Vercel origins to `FRONTEND_URL` |
| Health check fails | Wrong `PORT`, startup failure, or env validation failure | Check Render logs and required env vars |
| Path alias runtime errors | Build output not alias-rewritten | Ensure `npm run build:prod` runs `tsc-alias` |

## Cost Notes

The backend bill is primarily Render compute plus usage-based providers:

- Render web service
- Supabase PostgreSQL/Auth
- Upstash Redis
- Pinecone vector index
- Cloudflare R2 storage
- Anthropic API usage
- Resend email
- Stripe processing fees
