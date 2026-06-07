-- CreateEnum
CREATE TYPE "CustomFrameworkStatus" AS ENUM (
  'DRAFT',
  'PUBLISHED',
  'ARCHIVED'
);

-- CreateEnum
CREATE TYPE "EnterpriseContractStatus" AS ENUM (
  'DRAFT',
  'ACTIVE',
  'EXPIRED',
  'SUSPENDED',
  'CANCELLED',
  'ARCHIVED'
);

-- CreateTable
CREATE TABLE "CustomFramework" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "jurisdiction" TEXT,
  "regulator" TEXT,
  "category" TEXT,
  "status" "CustomFrameworkStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 1,
  "publishedAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "updatedByUserId" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomFramework_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFrameworkSection" (
  "id" TEXT NOT NULL,
  "frameworkId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "order" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomFrameworkSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFrameworkControl" (
  "id" TEXT NOT NULL,
  "frameworkId" TEXT NOT NULL,
  "sectionId" TEXT,
  "organizationId" TEXT NOT NULL,
  "code" TEXT,
  "title" TEXT NOT NULL,
  "requirement" TEXT NOT NULL,
  "guidance" TEXT,
  "evidenceRequired" JSONB,
  "severity" TEXT,
  "frequency" TEXT,
  "regulatorReference" TEXT,
  "sourceDocumentId" TEXT,
  "order" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomFrameworkControl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFrameworkVersion" (
  "id" TEXT NOT NULL,
  "frameworkId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomFrameworkVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnterpriseContract" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "status" "EnterpriseContractStatus" NOT NULL DEFAULT 'DRAFT',
  "contractName" TEXT,
  "contractNumber" TEXT,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "renewalDate" TIMESTAMP(3),
  "billingCycle" TEXT,
  "currency" TEXT DEFAULT 'KES',
  "monthlyAmount" DECIMAL(12,2),
  "annualAmount" DECIMAL(12,2),
  "notes" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "updatedByUserId" TEXT,
  "approvedByUserId" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EnterpriseContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnterprisePlanOverride" (
  "id" TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdByUserId" TEXT NOT NULL,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EnterprisePlanOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomFramework_organizationId_slug_key" ON "CustomFramework"("organizationId", "slug");
CREATE INDEX "CustomFramework_organizationId_idx" ON "CustomFramework"("organizationId");
CREATE INDEX "CustomFramework_status_idx" ON "CustomFramework"("status");
CREATE INDEX "CustomFramework_deletedAt_idx" ON "CustomFramework"("deletedAt");
CREATE INDEX "CustomFramework_createdAt_idx" ON "CustomFramework"("createdAt");
CREATE INDEX "CustomFrameworkSection_frameworkId_idx" ON "CustomFrameworkSection"("frameworkId");
CREATE INDEX "CustomFrameworkSection_organizationId_idx" ON "CustomFrameworkSection"("organizationId");
CREATE INDEX "CustomFrameworkSection_order_idx" ON "CustomFrameworkSection"("order");
CREATE INDEX "CustomFrameworkControl_frameworkId_idx" ON "CustomFrameworkControl"("frameworkId");
CREATE INDEX "CustomFrameworkControl_sectionId_idx" ON "CustomFrameworkControl"("sectionId");
CREATE INDEX "CustomFrameworkControl_organizationId_idx" ON "CustomFrameworkControl"("organizationId");
CREATE INDEX "CustomFrameworkControl_severity_idx" ON "CustomFrameworkControl"("severity");
CREATE UNIQUE INDEX "CustomFrameworkVersion_frameworkId_version_key" ON "CustomFrameworkVersion"("frameworkId", "version");
CREATE INDEX "CustomFrameworkVersion_frameworkId_idx" ON "CustomFrameworkVersion"("frameworkId");
CREATE INDEX "CustomFrameworkVersion_organizationId_idx" ON "CustomFrameworkVersion"("organizationId");
CREATE INDEX "CustomFrameworkVersion_createdAt_idx" ON "CustomFrameworkVersion"("createdAt");
CREATE INDEX "EnterpriseContract_organizationId_idx" ON "EnterpriseContract"("organizationId");
CREATE INDEX "EnterpriseContract_status_idx" ON "EnterpriseContract"("status");
CREATE INDEX "EnterpriseContract_startsAt_idx" ON "EnterpriseContract"("startsAt");
CREATE INDEX "EnterpriseContract_endsAt_idx" ON "EnterpriseContract"("endsAt");
CREATE INDEX "EnterpriseContract_deletedAt_idx" ON "EnterpriseContract"("deletedAt");
CREATE INDEX "EnterprisePlanOverride_contractId_idx" ON "EnterprisePlanOverride"("contractId");
CREATE INDEX "EnterprisePlanOverride_organizationId_idx" ON "EnterprisePlanOverride"("organizationId");
CREATE INDEX "EnterprisePlanOverride_key_idx" ON "EnterprisePlanOverride"("key");
CREATE INDEX "EnterprisePlanOverride_isActive_idx" ON "EnterprisePlanOverride"("isActive");
CREATE INDEX "EnterprisePlanOverride_startsAt_idx" ON "EnterprisePlanOverride"("startsAt");
CREATE INDEX "EnterprisePlanOverride_endsAt_idx" ON "EnterprisePlanOverride"("endsAt");

-- AddForeignKey
ALTER TABLE "CustomFramework" ADD CONSTRAINT "CustomFramework_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomFrameworkSection" ADD CONSTRAINT "CustomFrameworkSection_frameworkId_fkey" FOREIGN KEY ("frameworkId") REFERENCES "CustomFramework"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomFrameworkControl" ADD CONSTRAINT "CustomFrameworkControl_frameworkId_fkey" FOREIGN KEY ("frameworkId") REFERENCES "CustomFramework"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomFrameworkVersion" ADD CONSTRAINT "CustomFrameworkVersion_frameworkId_fkey" FOREIGN KEY ("frameworkId") REFERENCES "CustomFramework"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EnterpriseContract" ADD CONSTRAINT "EnterpriseContract_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EnterprisePlanOverride" ADD CONSTRAINT "EnterprisePlanOverride_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "EnterpriseContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
