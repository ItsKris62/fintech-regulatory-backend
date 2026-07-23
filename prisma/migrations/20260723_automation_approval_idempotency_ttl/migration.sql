-- AutomationApproval Phase B: idempotency + TTL, ahead of W-BI-01 / W-CONTENT-02 activation.
-- Additive only. Apply manually (per this project's convention - no `prisma migrate`),
-- then run `prisma generate` to sync the client.
--
-- Both columns are nullable: existing rows get NULL for both and are safe by
-- construction (recordApprovalDecision's expiry check is null-guarded; a NULL
-- idempotencyKey never collides with another NULL under a Postgres unique index).
-- All new rows get a non-null idempotencyKey enforced by the Zod input schema,
-- and a non-null expiresAt set server-side in createApproval.

ALTER TABLE "AutomationApproval" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "AutomationApproval" ADD COLUMN "expiresAt" TIMESTAMPTZ;

CREATE UNIQUE INDEX "AutomationApproval_idempotencyKey_key"
  ON "AutomationApproval"("idempotencyKey");

CREATE INDEX "AutomationApproval_status_expiresAt_idx"
  ON "AutomationApproval"("status", "expiresAt");
