-- Phase 5 Item 3: Row-Level Security (RLS) Pilot on VaultDocument
-- Enable and force RLS on VaultDocument
ALTER TABLE "VaultDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VaultDocument" FORCE ROW LEVEL SECURITY;

-- Drop existing policy if present
DROP POLICY IF EXISTS "vault_document_tenant_isolation" ON "VaultDocument";

-- Create tenant isolation policy
CREATE POLICY "vault_document_tenant_isolation" ON "VaultDocument"
  FOR ALL
  USING (
    "organizationId" = NULLIF(current_setting('app.current_org_id', true), '')
    OR current_setting('app.bypass_rls', true) = 'true'
  )
  WITH CHECK (
    "organizationId" = NULLIF(current_setting('app.current_org_id', true), '')
    OR current_setting('app.bypass_rls', true) = 'true'
  );
