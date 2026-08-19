# SheriaBot Secret Rotation Inventory - 2026-08-19

This inventory intentionally contains no secret values. It classifies scanner-confirmed or deployment-required credential classes for staging cutover preparation. Do not rotate production credentials automatically from this document; use it as the manual rotation tracker.

## Scanner Summary

- Backend current tracked source before remediation: 8 redacted findings.
- Backend current tracked source after remediation: 0 redacted findings in `src` and `.env.example`.
- Backend git history: 15 redacted findings remain in prior commits.
- Frontend git history: 0 findings.
- Frontend current tracked source and `.env.example`: 0 findings after remediation.
- Local `.env` and `.env.local` findings were scanner-confirmed but untracked. Treat them as live-looking until the owner confirms otherwise.

## Historical Finding Triage

| Detector class | File path | Commit SHA | File still exists? | Likely real? | Rotation required? | Notes |
|---|---|---:|---|---|---|---|
| Stripe token | `src/config/app.config.preview.test.ts` | `94f5771901de99a6b7c35609ff01d1aa2813634c` | Yes | No | NOT REQUIRED | Test fixture changed to neutral placeholder. |
| Generic API key | `src/routes/automation-incident.route.ts` | `654a7adbf1ccbd85351ba04b7433a96102a4c0a6` | Yes | No | NOT REQUIRED | Empty-input hash guard, not a credential; changed to computed constants. |
| Stripe token | `src/scripts/verify-backend-incidents.ts` | `654a7adbf1ccbd85351ba04b7433a96102a4c0a6` | Yes | No | NOT REQUIRED | Sanitizer test fixture changed to neutral placeholder. |
| JWT | `src/scripts/verify-backend-incidents.ts` | `654a7adbf1ccbd85351ba04b7433a96102a4c0a6` | Yes | No | NOT REQUIRED | Sanitizer test fixture changed to neutral placeholder. |
| Generic API key | `.env.example` | `4f4a2f5ed852c4dfce6d12aa9f1273d4881a1ba8` | Yes | No | NOT REQUIRED | Historical placeholder examples only; current file is scanner-clean. |
| Generic API key | `src/server/routers/AUTH_ROUTER_README.md` | `4f4a2f5ed852c4dfce6d12aa9f1273d4881a1ba8` | Yes | No | NOT REQUIRED | Documentation JWT-shaped examples changed to neutral placeholders. |
| Generic API key | `.env.example` | `9b533de5286c1bcdb6ab52c56143643eb73efc6b` | Yes | No | NOT REQUIRED | Historical placeholder examples only; current file is scanner-clean. |

## Rotation Inventory

| Secret class | Environment | Current-source exposure? | Historical exposure? | Local-only exposure? | Rotation required? | Provider/location | Post-rotation validation | Status |
|---|---|---|---|---|---|---|---|---|
| IntaSend API credentials | Staging, production | No | No | Possible in backend local `.env` | UNKNOWN | IntaSend dashboard | Backend can initiate sandbox status checks and STK after update | Await owner confirmation |
| IntaSend webhook challenge | Staging, production | No | No | Possible in backend local `.env` | UNKNOWN | IntaSend webhook settings and Render env | Valid webhook accepted; wrong challenge rejected | Await owner confirmation |
| SheriaBot automation HMAC | Staging, production | No | No | Possible in backend local `.env` | UNKNOWN | Render env / automation secret store | Signed approval callback verification succeeds | Await owner confirmation |
| Webhook ingress credential | Staging, production | No | No | Possible in backend local `.env` | UNKNOWN | Render env / n8n credential store | Ingress auth succeeds with new value, old value rejected | Await owner confirmation |
| Stripe secret | Dormant/staging disabled, production | No | Test fixture only | Possible in backend local `.env` | UNKNOWN | Stripe dashboard and Render env | Stripe disabled in staging; production Stripe smoke test after planned rotation | Await owner confirmation |
| JWT signing secrets | Supabase-managed | No | Documentation/test fixture only | Possible in backend local `.env` and frontend `.env.local` | UNKNOWN | Supabase dashboard | New sessions validate; old invalidated per policy | Await owner confirmation |
| Supabase service role/JWT | Development-UAT, production | No | No | Possible in backend local `.env` | UNKNOWN | Supabase project API settings | Backend admin auth calls and JWT validation succeed | Await owner confirmation |
| Database credentials | Development-UAT, production | No | No | Possible in backend local `.env` | UNKNOWN | Supabase database settings | `prisma migrate status` and app health pass | Await owner confirmation |
| Upstash/Redis | Staging, production | No | No | Possible in backend local `.env` | UNKNOWN | Upstash console | Rate limit and cron lock operations succeed | Await owner confirmation |
| Resend/email | Staging, production | No | Historical placeholder only | Possible in backend local `.env` | UNKNOWN | Resend dashboard | Test email or webhook validation succeeds | Await owner confirmation |
| Sentry | Backend/frontend local and deploy | No | No | Possible in backend local `.env` and frontend `.env.local` | UNKNOWN | Sentry org/project settings | Error capture and issue-read checks work | Await owner confirmation |
| Anthropic | Backend local and deploy | No | Historical placeholder only | Possible in backend local `.env` | UNKNOWN | Anthropic Console | Non-sensitive model health check succeeds | Await owner confirmation |
| OpenAI | Optional backend local and deploy | No | No | Possible in backend local `.env` | UNKNOWN | OpenAI Platform | Optional feature health check succeeds if configured | Await owner confirmation |
| Gemini | Optional backend local and deploy | No | No | Possible in backend local `.env` | UNKNOWN | Google AI / Gemini key management | Optional feature health check succeeds if configured | Await owner confirmation |
| Pinecone | Backend local and deploy | No | Historical placeholder only | Possible in backend local `.env` | UNKNOWN | Pinecone console | Index describe/query succeeds | Await owner confirmation |
| Cloudflare R2 private bucket | Backend local and deploy | No | Historical placeholder only | Possible in backend local `.env` | UNKNOWN | Cloudflare R2 API tokens | Presign/upload/download smoke test succeeds | Await owner confirmation |
| Cloudflare R2 public bucket | Backend/frontend local and deploy | No | Historical placeholder only | Possible in backend local `.env` | UNKNOWN | Cloudflare R2 API tokens | Avatar/logo public asset flow succeeds | Await owner confirmation |
| Hugging Face | Optional backend local | No | No | Possible in backend local `.env` | UNKNOWN | Hugging Face tokens | Optional embedding/model call succeeds if configured | Await owner confirmation |
| PostHog personal/project keys | Backend/frontend local and deploy | No | No | Possible in local env files | UNKNOWN | PostHog project settings | Analytics capture/query checks succeed | Await owner confirmation |

## Rotation Guidance

- REQUIRED: Use if any local-only finding is a real live credential that has been shared outside the operator machine or copied into provider dashboards from an exposed channel.
- RECOMMENDED: Use for live credentials found only in local untracked files when their provenance is unclear.
- NOT REQUIRED: Current tracked source test fixtures and documentation examples remediated in this branch.
- UNKNOWN: Needs owner/provider confirmation because scanner output was redacted and local `.env` values were intentionally not inspected.
