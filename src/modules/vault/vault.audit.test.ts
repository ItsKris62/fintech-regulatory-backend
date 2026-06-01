import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('vault audit logging', () => {
  const source = readFileSync(resolve(__dirname, 'vault.module.ts'), 'utf8');

  it('records upload lifecycle operations in AuditLog', () => {
    expect(source).toContain("action: 'vault_upload_url_issued'");
    expect(source).toContain("action: 'vault_upload_confirmed'");
    expect(source).toContain("action: 'vault_replacement_upload_url_issued'");
    expect(source).toContain("action: 'vault_document_replaced'");
  });

  it('records vault download URL issuance in AuditLog', () => {
    const downloadLogIndex = source.indexOf("type: 'vault.download.issued'");
    const auditIndex = source.indexOf("action: 'vault_download_url_issued'", downloadLogIndex);

    expect(downloadLogIndex).toBeGreaterThan(-1);
    expect(auditIndex).toBeGreaterThan(downloadLogIndex);
  });
});
