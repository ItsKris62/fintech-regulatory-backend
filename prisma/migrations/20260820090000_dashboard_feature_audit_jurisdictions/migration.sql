ALTER TABLE "RegulatoryApplication"
  ADD COLUMN IF NOT EXISTS "jurisdictionCode" TEXT NOT NULL DEFAULT 'KE';

ALTER TABLE "ApplicationFee"
  ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'KES';

ALTER TABLE "RegulatoryAlert"
  ADD COLUMN IF NOT EXISTS "jurisdictionCode" TEXT NOT NULL DEFAULT 'KE';

ALTER TABLE "AlertSubscription"
  ADD COLUMN IF NOT EXISTS "jurisdictions" TEXT[] NOT NULL DEFAULT ARRAY['KE']::TEXT[];

CREATE INDEX IF NOT EXISTS "RegulatoryApplication_jurisdictionCode_idx"
  ON "RegulatoryApplication"("jurisdictionCode");

CREATE INDEX IF NOT EXISTS "RegulatoryAlert_jurisdictionCode_idx"
  ON "RegulatoryAlert"("jurisdictionCode");
