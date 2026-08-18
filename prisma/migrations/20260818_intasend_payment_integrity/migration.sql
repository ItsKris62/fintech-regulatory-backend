-- IntaSend payment lifecycle and provider transaction integrity.
-- Additive only: no payment records are deleted or rewritten.

ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

DO $$
DECLARE
  duplicate_count integer;
BEGIN
  SELECT COUNT(*)
  INTO duplicate_count
  FROM (
    SELECT "provider", "providerTransactionId"
    FROM "Payment"
    WHERE "providerTransactionId" IS NOT NULL
    GROUP BY "provider", "providerTransactionId"
    HAVING COUNT(*) > 1
  ) duplicates;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'Cannot add Payment(provider, providerTransactionId) uniqueness: % duplicate provider transaction ids exist. Run the read-only duplicate report before retrying.', duplicate_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "Payment_provider_providerTransactionId_key"
ON "Payment" ("provider", "providerTransactionId")
WHERE "providerTransactionId" IS NOT NULL;
