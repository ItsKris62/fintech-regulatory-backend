-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM (
  'DRAFT',
  'ACTIVE',
  'PENDING_RENEWAL',
  'SUBMITTED',
  'APPROVED',
  'EXPIRED',
  'SUSPENDED',
  'REVOKED',
  'ARCHIVED'
);

-- AlterTable
ALTER TABLE "ComplianceEvent"
ADD COLUMN "sourceType" TEXT,
ADD COLUMN "sourceId" TEXT;

-- CreateTable
CREATE TABLE "License" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "licenseType" TEXT NOT NULL,
  "regulator" TEXT NOT NULL,
  "licenseNumber" TEXT,
  "status" "LicenseStatus" NOT NULL DEFAULT 'ACTIVE',
  "issueDate" TIMESTAMP(3),
  "expiryDate" TIMESTAMP(3),
  "renewalDueDate" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "approvedAt" TIMESTAMP(3),
  "assignedOwnerId" TEXT,
  "notes" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "updatedByUserId" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "License_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LicenseTimelineEvent" (
  "id" TEXT NOT NULL,
  "licenseId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "dueDate" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "assignedToUserId" TEXT,
  "evidenceDocumentId" TEXT,
  "complianceEventId" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LicenseTimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LicenseDocument" (
  "id" TEXT NOT NULL,
  "licenseId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "vaultDocumentId" TEXT NOT NULL,
  "documentType" TEXT,
  "notes" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LicenseDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LicenseFee" (
  "id" TEXT NOT NULL,
  "licenseId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "amount" DECIMAL(12,2),
  "currency" TEXT NOT NULL DEFAULT 'KES',
  "description" TEXT,
  "dueDate" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "createdByUserId" TEXT NOT NULL,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LicenseFee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceEvent_organizationId_sourceType_sourceId_key" ON "ComplianceEvent"("organizationId", "sourceType", "sourceId");
CREATE INDEX "ComplianceEvent_organizationId_sourceType_sourceId_idx" ON "ComplianceEvent"("organizationId", "sourceType", "sourceId");

CREATE INDEX "License_organizationId_idx" ON "License"("organizationId");
CREATE INDEX "License_status_idx" ON "License"("status");
CREATE INDEX "License_expiryDate_idx" ON "License"("expiryDate");
CREATE INDEX "License_renewalDueDate_idx" ON "License"("renewalDueDate");
CREATE INDEX "License_assignedOwnerId_idx" ON "License"("assignedOwnerId");
CREATE INDEX "License_deletedAt_idx" ON "License"("deletedAt");

CREATE INDEX "LicenseTimelineEvent_licenseId_idx" ON "LicenseTimelineEvent"("licenseId");
CREATE INDEX "LicenseTimelineEvent_organizationId_idx" ON "LicenseTimelineEvent"("organizationId");
CREATE INDEX "LicenseTimelineEvent_dueDate_idx" ON "LicenseTimelineEvent"("dueDate");
CREATE INDEX "LicenseTimelineEvent_status_idx" ON "LicenseTimelineEvent"("status");
CREATE INDEX "LicenseTimelineEvent_assignedToUserId_idx" ON "LicenseTimelineEvent"("assignedToUserId");
CREATE INDEX "LicenseTimelineEvent_complianceEventId_idx" ON "LicenseTimelineEvent"("complianceEventId");

CREATE UNIQUE INDEX "LicenseDocument_licenseId_vaultDocumentId_key" ON "LicenseDocument"("licenseId", "vaultDocumentId");
CREATE INDEX "LicenseDocument_licenseId_idx" ON "LicenseDocument"("licenseId");
CREATE INDEX "LicenseDocument_organizationId_idx" ON "LicenseDocument"("organizationId");
CREATE INDEX "LicenseDocument_vaultDocumentId_idx" ON "LicenseDocument"("vaultDocumentId");

CREATE INDEX "LicenseFee_licenseId_idx" ON "LicenseFee"("licenseId");
CREATE INDEX "LicenseFee_organizationId_idx" ON "LicenseFee"("organizationId");
CREATE INDEX "LicenseFee_dueDate_idx" ON "LicenseFee"("dueDate");
CREATE INDEX "LicenseFee_status_idx" ON "LicenseFee"("status");

-- AddForeignKey
ALTER TABLE "License" ADD CONSTRAINT "License_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "License" ADD CONSTRAINT "License_assignedOwnerId_fkey" FOREIGN KEY ("assignedOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "License" ADD CONSTRAINT "License_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "License" ADD CONSTRAINT "License_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LicenseTimelineEvent" ADD CONSTRAINT "LicenseTimelineEvent_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LicenseTimelineEvent" ADD CONSTRAINT "LicenseTimelineEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LicenseTimelineEvent" ADD CONSTRAINT "LicenseTimelineEvent_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LicenseTimelineEvent" ADD CONSTRAINT "LicenseTimelineEvent_evidenceDocumentId_fkey" FOREIGN KEY ("evidenceDocumentId") REFERENCES "VaultDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LicenseTimelineEvent" ADD CONSTRAINT "LicenseTimelineEvent_complianceEventId_fkey" FOREIGN KEY ("complianceEventId") REFERENCES "ComplianceEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LicenseTimelineEvent" ADD CONSTRAINT "LicenseTimelineEvent_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LicenseTimelineEvent" ADD CONSTRAINT "LicenseTimelineEvent_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LicenseDocument" ADD CONSTRAINT "LicenseDocument_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LicenseDocument" ADD CONSTRAINT "LicenseDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LicenseDocument" ADD CONSTRAINT "LicenseDocument_vaultDocumentId_fkey" FOREIGN KEY ("vaultDocumentId") REFERENCES "VaultDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LicenseDocument" ADD CONSTRAINT "LicenseDocument_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LicenseFee" ADD CONSTRAINT "LicenseFee_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LicenseFee" ADD CONSTRAINT "LicenseFee_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LicenseFee" ADD CONSTRAINT "LicenseFee_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LicenseFee" ADD CONSTRAINT "LicenseFee_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
