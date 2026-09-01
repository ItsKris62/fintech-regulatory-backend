import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSrc(relativePath: string): string {
  return readFileSync(resolve(__dirname, '../../..', relativePath), 'utf8');
}

describe('vault storage capacity accounting & concurrency reservation', () => {
  it('enforces total storage quota against persistent active vault documents rather than monthly reset counters', () => {
    const vaultCode = readSrc('src/modules/vault/vault.module.ts');
    const usageTrackingCode = readSrc('src/services/usage-tracking.service.ts');
    const billingRouterCode = readSrc('src/server/routers/billing.router.ts');

    expect(vaultCode).toContain('prisma.vaultDocument.aggregate({');
    expect(vaultCode).toContain('where: { organizationId: orgId, isArchived: false, deletedAt: null }');
    expect(vaultCode).toContain('_sum: { fileSize: true }');

    expect(usageTrackingCode).toContain('readAuthoritativeStorage');
    expect(usageTrackingCode).toContain('prisma.vaultDocument.aggregate');

    expect(billingRouterCode).toContain('prisma.vaultDocument.aggregate');
  });

  it('atomically reserves incoming upload bytes and enforces concurrency limits to prevent parallel race conditions', () => {
    const vaultCode = readSrc('src/modules/vault/vault.module.ts');

    expect(vaultCode).toContain('sheriabot:vault:reserved_bytes:${orgId}');
    expect(vaultCode).toContain('currentUsedBytes + reservedBytes + incomingFileSizeBytes > limits.vaultTotalQuotaBytes');
    expect(vaultCode).toContain('redis.incrby(reservedBytesKey, incomingFileSizeBytes)');
    expect(vaultCode).toContain('redis.expire(reservedBytesKey, 600)');
    expect(vaultCode).toContain('releaseVaultStorageReservation');
  });

  it('releases reserved bytes on upload confirmation and malware detection abort', () => {
    const vaultCode = readSrc('src/modules/vault/vault.module.ts');

    expect(vaultCode).toContain('if (scanResult.status === \'infected\') {');
    expect(vaultCode).toContain('await releaseVaultStorageReservation(pendingUpload.organizationId, pendingUpload.declaredSize);');
    expect(vaultCode).toContain('await deletePendingUpload(pendingUpload.documentId);');
    expect(vaultCode).toContain('await releaseVaultStorageReservation(pendingUpload.organizationId, pendingUpload.declaredSize);');
  });
});
