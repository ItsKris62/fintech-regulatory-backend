-- ============================================================
-- Analytics Dashboard Sprint — Index Migration
-- Date: 2026-05-24
-- Apply: Supabase SQL Editor (run forward block only)
-- Prisma: after applying, run `pnpm prisma generate` in backend
-- ============================================================

-- ============================================================
-- FORWARD MIGRATION
-- ============================================================

-- 1. Composite index on ComplianceQuery for DAU and queries-per-user
--    Enables: COUNT(DISTINCT "userId") WHERE "createdAt" >= X
--    CONCURRENTLY avoids locking the table during creation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ComplianceQuery_userId_createdAt_idx"
  ON "ComplianceQuery" ("userId", "createdAt" DESC);

-- 2. createdAt index on QueryFeedback for date-range aggregation
--    Enables: feedback summary WHERE "createdAt" BETWEEN X AND Y
CREATE INDEX CONCURRENTLY IF NOT EXISTS "QueryFeedback_createdAt_idx"
  ON "QueryFeedback" ("createdAt" DESC);

-- 3. rating index on QueryFeedback for up/down count aggregation
--    Enables: COUNT(*) GROUP BY "rating" or WHERE "rating" = 'up'
CREATE INDEX CONCURRENTLY IF NOT EXISTS "QueryFeedback_rating_idx"
  ON "QueryFeedback" ("rating");

-- ============================================================
-- VERIFY (run after forward block — expected: all VALID)
-- ============================================================
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE tablename IN ('ComplianceQuery', 'QueryFeedback')
--   AND indexname IN (
--     'ComplianceQuery_userId_createdAt_idx',
--     'QueryFeedback_createdAt_idx',
--     'QueryFeedback_rating_idx'
--   );

-- ============================================================
-- ROLLBACK (uncomment and run to revert — CONCURRENTLY required
--           outside a transaction block in Supabase)
-- ============================================================
-- DROP INDEX CONCURRENTLY IF EXISTS "ComplianceQuery_userId_createdAt_idx";
-- DROP INDEX CONCURRENTLY IF EXISTS "QueryFeedback_createdAt_idx";
-- DROP INDEX CONCURRENTLY IF EXISTS "QueryFeedback_rating_idx";
