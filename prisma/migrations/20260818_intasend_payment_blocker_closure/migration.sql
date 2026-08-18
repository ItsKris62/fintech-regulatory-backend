-- Add an explicit purpose for new payment rows.
-- Historical rows remain NULL unless a trusted backfill is performed separately.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentPurpose') THEN
    CREATE TYPE "PaymentPurpose" AS ENUM ('INITIAL_PURCHASE', 'RENEWAL');
  END IF;
END $$;

ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "paymentPurpose" "PaymentPurpose";

CREATE INDEX IF NOT EXISTS "Payment_paymentPurpose_idx"
  ON "Payment"("paymentPurpose");
