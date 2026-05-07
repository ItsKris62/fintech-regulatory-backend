-- =============================================================================
-- Migration: Add OrganizationMember junction table
-- Date: 2026-05-04
-- Purpose: Support multi-member organizations. Fixes audit finding F-01 where
--          verifyOrgAccess queried a non-existent model, breaking item updates
--          and category drill-down for all users.
-- Run in: Supabase SQL editor (service-role context)
-- =============================================================================

-- Step 1: Create enum types
-- Note: IF NOT EXISTS is not supported for CREATE TYPE in older Postgres versions;
-- these are safe to run fresh since the types do not exist yet.

CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'INVITED', 'SUSPENDED', 'REMOVED');

-- Step 2: Create the OrganizationMember table

CREATE TABLE "OrganizationMember" (
  "id"             TEXT         NOT NULL,
  "userId"         TEXT         NOT NULL,
  "organizationId" TEXT         NOT NULL,
  "role"           "MemberRole" NOT NULL DEFAULT 'MEMBER',
  "invitedBy"      TEXT,
  "invitedAt"      TIMESTAMP(3),
  "joinedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status"         "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "OrganizationMember_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "OrganizationMember_organizationId_fkey"
    FOREIGN KEY ("organizationId")
    REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "OrganizationMember_invitedBy_fkey"
    FOREIGN KEY ("invitedBy")
    REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

-- Step 3: Unique constraint (enforces one membership row per user per org)

CREATE UNIQUE INDEX "OrganizationMember_userId_organizationId_key"
  ON "OrganizationMember"("userId", "organizationId");

-- Step 4: Performance indexes (matches Prisma @@index directives)

CREATE INDEX "OrganizationMember_organizationId_status_idx"
  ON "OrganizationMember"("organizationId", "status");

CREATE INDEX "OrganizationMember_userId_status_idx"
  ON "OrganizationMember"("userId", "status");

-- Step 5: Trigger to auto-update updatedAt on row modification

CREATE OR REPLACE FUNCTION update_organization_member_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OrganizationMember_updatedAt_trigger"
  BEFORE UPDATE ON "OrganizationMember"
  FOR EACH ROW
  EXECUTE FUNCTION update_organization_member_updated_at();

-- Step 6: Backfill — insert one OWNER row for every User who already has
--         a non-null organizationId (the current 1:1 pilot model).
--         Uses gen_random_uuid() cast to text as a cuid-compatible placeholder.
--         Idempotent: ON CONFLICT DO NOTHING prevents duplicate inserts.

INSERT INTO "OrganizationMember" (
  "id",
  "userId",
  "organizationId",
  "role",
  "status",
  "joinedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  u."id",
  u."organizationId",
  'OWNER'::"MemberRole",
  'ACTIVE'::"MemberStatus",
  COALESCE(u."createdAt", CURRENT_TIMESTAMP),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "User" u
WHERE u."organizationId" IS NOT NULL
ON CONFLICT ("userId", "organizationId") DO NOTHING;
