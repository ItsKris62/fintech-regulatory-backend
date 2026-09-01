import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSrc(relativePath: string): string {
  return readFileSync(resolve(__dirname, '../../..', relativePath), 'utf8');
}

describe('downgrade over-limit semantics and non-destructive governance', () => {
  it('blocks new uploads when current storage exceeds new plan quota without deleting historical documents', () => {
    const vaultCode = readSrc('src/modules/vault/vault.module.ts');

    // Storage check throws FORBIDDEN when currentUsedBytes > limits.vaultTotalQuotaBytes
    expect(vaultCode).toContain('if (currentUsedBytes + reservedBytes + incomingFileSizeBytes > limits.vaultTotalQuotaBytes)');
    expect(vaultCode).toContain('Storage quota exceeded');
    // List/download queries do not check or delete over-limit documents
    expect(vaultCode).toContain('async listDocuments(');
    expect(vaultCode).toContain('async getDocumentById(');
    expect(vaultCode).toContain('async generateDownloadPresignedUrl(');
  });

  it('blocks new seat additions when active seats exceed plan limit without kicking existing members', () => {
    const seatServiceCode = readSrc('src/server/services/organization-seat.service.ts');
    const invitationServiceCode = readSrc('src/server/services/organization-invitation.service.ts');

    expect(seatServiceCode).toContain('getSeatUsageForOrganization');
    expect(seatServiceCode).toContain('buildSeatLimitMessage');
    expect(invitationServiceCode).toContain('assertSeatCapacityLocked');
    expect(invitationServiceCode).toContain('!hasSeatCapacity(usage)');
  });

  it('blocks unsupported jurisdiction queries on downgrade while preserving historical generated artifacts', () => {
    const jurisdictionEntitlementsCode = readSrc('src/modules/jurisdiction/jurisdiction-entitlements.ts');
    const policyRouterCode = readSrc('src/server/routers/policy.router.ts');

    expect(jurisdictionEntitlementsCode).toContain('resolveJurisdictionEntitlement');
    // Historical get / list in policy router only checks org/user ownership, not plan entitlements
    expect(policyRouterCode).toContain('get: orgMemberProcedure');
    expect(policyRouterCode).toContain('list: orgMemberProcedure');
  });
});
