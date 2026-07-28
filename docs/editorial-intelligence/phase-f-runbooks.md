# Phase F: Activation and Rollback Runbooks

## 1. Activation
- **Pre-requisite**: No workflows should be activated until all backend migrations are deployed.
- **Steps**:
  1. Deploy `fintech-regulatory-backend`.
  2. Wait for deployment health checks to pass.
  3. In n8n, activate W-CONTENT-01 through W-CONTENT-03.
  4. Ensure W-CONTENT-04 through W-CONTENT-07 remain INACTIVE until Phase G.

## 2. Migration
- Database migrations must be run sequentially during the scheduled deployment window.
- Ensure `BlogResearchPack` fields (`reviewerStatus`, `reviewedById`, `reviewedAt`, `rejectionNote`) are added.

## 3. Backfill
- W-CONTENT-07 is scheduled to run daily at 8:00 AM EAT. 
- A manual backfill is not required as the monitor queries the database dynamically.

## 4. Shadow Mode
- The `adminSetStatus` shadow readiness evaluator is running passively.
- It logs publication-readiness failures but does NOT block the actual status transition.
- Monitor logs for `[SHADOW EVALUATOR]` to measure accuracy.

## 5. Rollback
- If the shadow evaluator causes performance issues or if the API contracts break existing frontend features, roll back the backend deployment to the previous stable SHA.
- In n8n, immediately deactivate W-CONTENT-01 through W-CONTENT-03.
- Database rollbacks for Phase F migrations are safe as the fields are nullable.
