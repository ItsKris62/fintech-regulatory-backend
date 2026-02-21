# SheriaBot API — Railway Deployment Guide

## Prerequisites

- [Railway account](https://railway.app/) (free tier works)
- [Railway CLI](https://docs.railway.app/guides/cli) installed: `npm i -g @railway/cli`
- GitHub repository connected to Railway
- All environment variables ready (see `.env.example`)

---

## 1. Railway Project Setup

### Create project

```bash
railway login
railway init    # creates a new project
railway link    # or link to existing project
```

### Provision services

```bash
# PostgreSQL
railway add --plugin postgresql

# Redis
railway add --plugin redis
```

Railway auto-injects `DATABASE_URL` and `REDIS_URL` for provisioned databases.

---

## 2. Environment Variables

Set all variables from `.env.example` in the Railway dashboard:

**Settings → Variables → Raw Editor**

Required variables (DATABASE_URL and REDIS_URL are auto-set by Railway plugins):

```
NODE_ENV=production
APP_URL=https://your-app.up.railway.app
FRONTEND_URL=https://your-frontend.vercel.app
JWT_SECRET=<generate: openssl rand -base64 48>
REFRESH_TOKEN_SECRET=<generate: openssl rand -base64 48>
RESEND_API_KEY=re_...
FROM_EMAIL=noreply@yourdomain.com
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-3-haiku-20240307
PINECONE_API_KEY=...
PINECONE_ENVIRONMENT=us-east-1-aws
PINECONE_INDEX_NAME=sheriabot-legal-corpus
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=sheriabot-documents
R2_PUBLIC_URL=https://your-bucket.r2.dev
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW=15m
```

---

## 3. Database Migration

Migrations run automatically on deploy via `prestart:prod` script.

To run manually:

```bash
railway run pnpm run db:migrate:prod
```

To seed production data:

```bash
railway run pnpm run db:seed:prod
```

---

## 4. Deploy

### Option A: Auto-deploy (recommended)

Connect your GitHub repo in Railway dashboard. Pushes to `main` auto-deploy.

### Option B: CLI deploy

```bash
railway up
```

### Option C: GitHub Actions

Add `RAILWAY_TOKEN` as a GitHub secret:

1. Railway dashboard → Account Settings → Tokens → Create Token
2. GitHub repo → Settings → Secrets → New Repository Secret → `RAILWAY_TOKEN`

Pushes to `main` trigger production deploy, pushes to `staging` trigger staging deploy.

---

## 5. Verify Deployment

```bash
# Quick health check
curl https://your-app.up.railway.app/health

# Detailed health check (database, redis, services)
curl https://your-app.up.railway.app/health/detailed

# Root info
curl https://your-app.up.railway.app/
```

---

## 6. Monitoring & Alerts

### View logs

- **Railway dashboard**: Select your service → Deployments → View Logs
- **CLI**: `railway logs` or `railway logs --follow`

### Built-in metrics

Railway provides CPU, memory, and network metrics in the dashboard under **Metrics** tab.

### Interpreting `/health/detailed`

| Status | Meaning | Action |
|--------|---------|--------|
| `ok` | All services healthy | None |
| `degraded` | Redis or a non-critical service is down | Check Redis connection, may self-recover |
| `down` | Database AND Redis both unreachable | Immediate investigation required |

### What to do when degraded

1. Check Railway dashboard for service health
2. Verify Redis is running: `railway logs --service redis`
3. The API continues to function without Redis (no caching/rate limiting)
4. Redis typically auto-recovers; if not, restart the Redis plugin

### What to do when down

1. Check PostgreSQL: `railway logs --service postgresql`
2. Check API logs: `railway logs`
3. Verify DATABASE_URL is correct in variables
4. Try redeploying: `railway up`

---

## 7. Rollback

### Via dashboard

1. Go to your service → Deployments
2. Find the last working deployment
3. Click the three dots → Rollback

### Via CLI

```bash
# List recent deployments
railway deployments

# Rollback to previous
railway rollback
```

---

## 8. Scaling

### When to scale

| Symptom | Solution |
|---------|----------|
| Response times > 2s consistently | Increase RAM/CPU |
| Memory usage > 80% of allocated | Increase RAM |
| Database connections exhausted | Increase connection pool or upgrade DB plan |
| Rate limit errors from Anthropic | Reduce AI request rate or upgrade API plan |

### How to scale

**Railway dashboard → Service → Settings → Resources**

- **Starter plan** (free): 512 MB RAM, shared CPU — good for development
- **Pro plan** ($5/mo): Up to 8 GB RAM, dedicated CPU — good for production
- **Scale replicas**: Set `numReplicas` in `railway.toml` (requires Pro plan)

### Database scaling

- Free tier: 1 GB storage, 5 connections
- Pro tier: Scale storage as needed, increase connection pool in config

---

## 9. Troubleshooting

### Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `ECONNREFUSED` on DATABASE_URL | DB not provisioned or URL wrong | Check Railway plugins, verify DATABASE_URL |
| `prisma migrate deploy` fails | Schema drift or missing migrations | Run `pnpm exec prisma migrate reset` (destroys data!) or fix migration |
| `ENOMEM` / OOM killed | Not enough RAM | Scale up in Railway settings |
| `SIGTERM` + immediate restart | Health check failing | Check `/health` endpoint, verify PORT matches |
| `Cannot find module '@/...'` | Path aliases not resolved | Ensure `tsc-alias` runs in `build:prod` |
| `Connection timeout` to Redis | Redis plugin not linked | Re-add Redis plugin, check REDIS_URL |

### Debug commands

```bash
# SSH into running container
railway shell

# Run one-off command
railway run node -e "console.log(process.env.DATABASE_URL ? 'DB OK' : 'DB MISSING')"

# Check Prisma migrations status
railway run pnpm exec prisma migrate status
```

---

## 10. Cost Estimate

| Service | Free Tier | When to Upgrade |
|---------|-----------|-----------------|
| **Railway** | $5 credit/mo, 512 MB RAM | > 100 daily users or need custom domains |
| **Pinecone** | 1 index, 100K vectors | > 100K document chunks |
| **Resend** | 100 emails/day | > 100 daily notifications |
| **Cloudflare R2** | 10 GB, 10M reads/mo | > 10 GB documents |
| **Anthropic** | $5 signup credit | After credits; ~$0.25/1M input tokens (Haiku) |

**Estimated monthly cost at launch**: $0–$10 (within free tiers)
**Estimated at 500 users**: ~$25–$50/mo (Railway Pro + Anthropic usage)
