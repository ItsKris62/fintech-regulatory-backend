-- SheriaBot IntaSend payment migration preflight checks.
-- Safe to run against staging or production as a read-only report before
-- prisma migrate deploy. This file intentionally contains no DML/DDL.

BEGIN;
SET TRANSACTION READ ONLY;

-- 1. Provider transaction duplicates that would block the partial unique index.
SELECT
  "provider",
  "providerTransactionId",
  COUNT(*) AS duplicate_count,
  ARRAY_AGG("id" ORDER BY "createdAt") AS payment_ids
FROM "Payment"
WHERE "providerTransactionId" IS NOT NULL
GROUP BY "provider", "providerTransactionId"
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, "provider", "providerTransactionId";

-- 2. Provider/reference relationship sanity for IntaSend/M-Pesa lifecycle.
SELECT
  "status",
  COUNT(*) AS payments_without_provider_reference
FROM "Payment"
WHERE "provider" = 'MPESA'
  AND "providerTransactionId" IS NULL
GROUP BY "status"
ORDER BY "status";

SELECT
  COUNT(*) AS completed_mpesa_without_provider_reference
FROM "Payment"
WHERE "provider" = 'MPESA'
  AND "status" = 'COMPLETED'
  AND "providerTransactionId" IS NULL;

-- 3. PaymentStatus distribution before/after migration.
SELECT
  "status",
  COUNT(*) AS payment_count,
  MIN("createdAt") AS oldest_payment,
  MAX("createdAt") AS newest_payment
FROM "Payment"
GROUP BY "status"
ORDER BY "status";

-- 4. PaymentPurpose distribution. Run after the blocker-closure migration.
-- If the column has not been created yet, this query is expected to fail.
SELECT
  COALESCE("paymentPurpose"::text, 'NULL') AS payment_purpose,
  COUNT(*) AS payment_count,
  MIN("createdAt") AS oldest_payment,
  MAX("createdAt") AS newest_payment
FROM "Payment"
GROUP BY COALESCE("paymentPurpose"::text, 'NULL')
ORDER BY payment_purpose;

-- 5. Invoice uniqueness sanity. The schema already has a unique invoiceNumber;
-- this highlights any legacy/conflicting data before release work proceeds.
SELECT
  "invoiceNumber",
  COUNT(*) AS duplicate_count,
  ARRAY_AGG("id" ORDER BY "createdAt") AS payment_ids
FROM "Payment"
WHERE "invoiceNumber" IS NOT NULL
GROUP BY "invoiceNumber"
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, "invoiceNumber";

-- 6. Verify target indexes after migration.
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'Payment'
  AND indexname IN (
    'Payment_provider_providerTransactionId_key',
    'Payment_paymentPurpose_idx'
  )
ORDER BY indexname;

ROLLBACK;
