ALTER TABLE "AutomationIncidentOccurrence" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "AutomationIncidentOccurrence_idempotencyKey_key" ON "AutomationIncidentOccurrence"("idempotencyKey");
