# Sprint 3 Production Readiness Checklist

Date: 2026-05-31

## Vault

- [ ] `MALWARE_SCAN_ENABLED=true`, `CLAMAV_HOST`, `CLAMAV_PORT`, and `CLAMAV_TIMEOUT_MS` configured in production.
- [ ] New vault upload without scanner configuration is rejected in production before presign.
- [ ] New vault upload confirms only after size, MIME metadata, SHA-256 content hash, and malware scan pass.
- [ ] EICAR test file is rejected by ClamAV and writes `vault_upload_quarantined_malware`.
- [ ] `pnpm vault:cron` dry-run logs reviewed; set `VAULT_RECONCILIATION_DRY_RUN=false` only after clean review.
- [ ] Optional integrity run with `VAULT_RECONCILIATION_VERIFY_HASHES=true` reports zero `hashMismatches`.
- [ ] `pnpm vault:cleanup-deleted` purges only soft-deleted rows beyond `VAULT_DELETED_RETENTION_DAYS`.

## Admin Lifecycle

- [ ] Admin user suspension sets `User.status=SUSPENDED` and `accountStatus=suspended`; login is blocked as suspended.
- [ ] Admin user reactivation only restores suspended accounts, not `accountStatus=cancelled` accounts.
- [ ] Admin user deletion/anonymization sets `accountStatus=cancelled` and `deletedAt`.
- [ ] Admin organization suspension sets `Organization.subscriptionStatus=SUSPENDED`.
- [ ] Billing cancellation/grace flows do not use `SUSPENDED` for customer cancellation semantics.

## Notifications And Email

- [ ] No logs contain `getUserEmail_not_implemented`.
- [ ] Policy-ready email resolves by direct `to`/`email`, `userId`, or policy owner.
- [ ] Compliance alert email resolves by direct `to`/`email` or `userId`.
- [ ] Suppressed recipients in `SuppressionList` are skipped before Resend send.
- [ ] Auth, billing, policy-ready, and compliance-alert sends write `critical_email_*` audit logs.
- [ ] Failed sends enqueue for retry and `softbounce:cron`/Resend webhook suppression path is operational.

## Smoke Matrix

- [ ] Auth: register, verify, login, password reset, suspended login block, cancelled login block.
- [ ] Billing: checkout, webhook activation, payment failed, cancellation/grace, plan downgrade.
- [ ] Uploads: vault upload, infected upload rejection, download URL, delete, retention purge.
- [ ] Compliance query: grounded answer, citations, usage tracking.
- [ ] Gap analysis: upload/analyze/export.
- [ ] Checklist: generate, update, export.
- [ ] Policy generation: queue job, completion, policy-ready notification.
- [ ] Support: ticket create, admin email, customer confirmation, status update.
- [ ] Notifications: in-app create/read/delete and email preference behavior.
- [ ] Admin actions: suspend/reactivate user, suspend/reactivate org, audit export.
