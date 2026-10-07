-- Rollback: 20261007120000_phase1_jurisdiction_dashboard.rollback.sql
-- CRITICAL DATA SAFETY RULE:
-- Rollback for Phase 1 is application-level via feature flag / routing.
-- Never drop columns or destroy customer assessment state during rollback!
-- This script only removes newly introduced indexes if an emergency DDL revert is required before live traffic.

DROP INDEX IF EXISTS "ComplianceItem_organizationId_requirementKey_key";
DROP INDEX IF EXISTS "ComplianceItem_organizationId_jurisdictionCode_idx";
DROP INDEX IF EXISTS "ComplianceScoreSnapshot_organizationId_jurisdictionCode_calculatedAt_idx";
