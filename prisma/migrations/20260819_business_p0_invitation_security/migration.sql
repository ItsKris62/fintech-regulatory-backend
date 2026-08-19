-- Phase 1 Business P0 invitation security fields.
-- Additive/backward-safe: existing invitation rows remain valid.

ALTER TABLE "Invitation"
  ADD COLUMN "organizationRole" "MemberRole",
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "revokedBy" TEXT;

CREATE INDEX "Invitation_organizationId_used_revokedAt_expiresAt_idx"
  ON "Invitation"("organizationId", "used", "revokedAt", "expiresAt");
