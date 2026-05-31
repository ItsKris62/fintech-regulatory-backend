CREATE TABLE "RegulatoryApplication" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "regulator" TEXT NOT NULL,
  "licenseType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "referenceNumber" TEXT,
  "nextAction" TEXT,
  "dueDate" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "decidedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RegulatoryApplication_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApplicationTimelineEvent" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "eventDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApplicationTimelineEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApplicationDocument" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'REQUIRED',
  "vaultDocumentId" TEXT,
  "notes" TEXT,
  "uploadedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApplicationDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApplicationFee" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApplicationFee_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApplicationRegulatorFeedback" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "fromName" TEXT,
  "message" TEXT NOT NULL,
  "actionRequired" BOOLEAN NOT NULL DEFAULT false,
  "dueDate" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApplicationRegulatorFeedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RegulatoryApplication_organizationId_idx" ON "RegulatoryApplication"("organizationId");
CREATE INDEX "RegulatoryApplication_userId_idx" ON "RegulatoryApplication"("userId");
CREATE INDEX "RegulatoryApplication_status_idx" ON "RegulatoryApplication"("status");
CREATE INDEX "RegulatoryApplication_createdAt_idx" ON "RegulatoryApplication"("createdAt");
CREATE INDEX "RegulatoryApplication_deletedAt_idx" ON "RegulatoryApplication"("deletedAt");

CREATE INDEX "ApplicationTimelineEvent_applicationId_idx" ON "ApplicationTimelineEvent"("applicationId");
CREATE INDEX "ApplicationTimelineEvent_eventDate_idx" ON "ApplicationTimelineEvent"("eventDate");

CREATE INDEX "ApplicationDocument_applicationId_idx" ON "ApplicationDocument"("applicationId");
CREATE INDEX "ApplicationDocument_status_idx" ON "ApplicationDocument"("status");

CREATE INDEX "ApplicationFee_applicationId_idx" ON "ApplicationFee"("applicationId");
CREATE INDEX "ApplicationFee_status_idx" ON "ApplicationFee"("status");

CREATE INDEX "ApplicationRegulatorFeedback_applicationId_idx" ON "ApplicationRegulatorFeedback"("applicationId");
CREATE INDEX "ApplicationRegulatorFeedback_receivedAt_idx" ON "ApplicationRegulatorFeedback"("receivedAt");

ALTER TABLE "RegulatoryApplication" ADD CONSTRAINT "RegulatoryApplication_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RegulatoryApplication" ADD CONSTRAINT "RegulatoryApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApplicationTimelineEvent" ADD CONSTRAINT "ApplicationTimelineEvent_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "RegulatoryApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApplicationTimelineEvent" ADD CONSTRAINT "ApplicationTimelineEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApplicationDocument" ADD CONSTRAINT "ApplicationDocument_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "RegulatoryApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApplicationDocument" ADD CONSTRAINT "ApplicationDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApplicationFee" ADD CONSTRAINT "ApplicationFee_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "RegulatoryApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApplicationFee" ADD CONSTRAINT "ApplicationFee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApplicationRegulatorFeedback" ADD CONSTRAINT "ApplicationRegulatorFeedback_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "RegulatoryApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApplicationRegulatorFeedback" ADD CONSTRAINT "ApplicationRegulatorFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
