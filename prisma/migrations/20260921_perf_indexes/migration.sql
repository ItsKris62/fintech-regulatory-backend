-- Migration: 20260921_perf_indexes
-- Description: Zero-downtime concurrent index creation for Session and AuditLog hot queries.
--
-- In production PostgreSQL, CREATE INDEX CONCURRENTLY executes without acquiring an
-- EXCLUSIVE lock on the table, allowing uninterrupted reads and writes during index build.
-- Note: CONCURRENTLY cannot run inside a multi-statement transaction block.

-- 1. Index on Session (userId, expiresAt) for active session expiration filtering
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Session_userId_expiresAt_idx" 
  ON "Session"("userId", "expiresAt");

-- 2. Index on Session (id, userId, expiresAt) for fast session token verification
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Session_id_userId_expiresAt_idx" 
  ON "Session"("id", "userId", "expiresAt");

-- 3. Composite index on AuditLog (userId, createdAt DESC) for compliance audit queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AuditLog_userId_createdAt_idx" 
  ON "AuditLog"("userId", "createdAt" DESC);
