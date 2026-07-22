-- n8n automation integration Phase 2: backend-owned approval gate.
-- Additive only. Apply manually (per this project's convention - no `prisma migrate`),
-- then run `prisma generate` to sync the client.

CREATE TABLE "AutomationApproval" (
  "id" TEXT NOT NULL,
  "department" TEXT NOT NULL,
  "workflow" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "callbackUrl" TEXT NOT NULL,
  "metadata" JSONB,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "decidedBy" TEXT,
  "decidedAt" TIMESTAMP(3),
  "callbackDeliveredAt" TIMESTAMP(3),
  "callbackError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AutomationApproval_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AutomationApproval_status_idx" ON "AutomationApproval"("status");
CREATE INDEX "AutomationApproval_department_idx" ON "AutomationApproval"("department");
CREATE INDEX "AutomationApproval_workflow_idx" ON "AutomationApproval"("workflow");
CREATE INDEX "AutomationApproval_createdAt_idx" ON "AutomationApproval"("createdAt");
