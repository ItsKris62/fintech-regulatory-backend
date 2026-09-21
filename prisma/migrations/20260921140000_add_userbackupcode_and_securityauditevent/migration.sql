-- CreateTable
CREATE TABLE "UserBackupCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBackupCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityAuditEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "eventType" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserBackupCode_userId_idx" ON "UserBackupCode"("userId");

-- CreateIndex
CREATE INDEX "SecurityAuditEvent_userId_createdAt_idx" ON "SecurityAuditEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityAuditEvent_eventType_createdAt_idx" ON "SecurityAuditEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityAuditEvent_organizationId_createdAt_idx" ON "SecurityAuditEvent"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "UserBackupCode" ADD CONSTRAINT "UserBackupCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityAuditEvent" ADD CONSTRAINT "SecurityAuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
