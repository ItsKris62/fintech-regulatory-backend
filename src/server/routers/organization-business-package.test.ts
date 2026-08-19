import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function src(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('Business package schema and release contract', () => {
  const schema = readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');
  const phase1Migration = readFileSync(
    resolve(__dirname, '../../../prisma/migrations/20260819_business_p0_invitation_security/migration.sql'),
    'utf8',
  );
  const phase3Migration = readFileSync(
    resolve(__dirname, '../../../prisma/migrations/20260819_business_security_policy/migration.sql'),
    'utf8',
  );
  const entitlements = readFileSync(resolve(__dirname, '../../config/entitlements.config.ts'), 'utf8');
  const router = src('organization.router.ts');

  it('keeps Business at six total seats including pending invitations', () => {
    expect(entitlements).toContain('maxSeats:              6');
    expect(router).toContain('pendingInvitations.length');
    expect(router).toContain('getSeatUsageForOrganization');
  });

  it('keeps Phase 1 invitation migration additive and legacy-token compatible', () => {
    expect(phase1Migration).toContain('ADD COLUMN "organizationRole"');
    expect(phase1Migration).toContain('ADD COLUMN "revokedAt"');
    expect(phase1Migration).toContain('ADD COLUMN "revokedBy"');
    expect(router).toContain('hashInvitationToken(rawToken)');
  });

  it('adds only nullable/defaulted MFA policy fields for Phase 3', () => {
    expect(schema).toContain('requireMfa             Boolean');
    expect(schema).toContain('@default(false)');
    expect(schema).toContain('mfaPolicyEnabledAt     DateTime?');
    expect(schema).toContain('mfaPolicyUpdatedBy     String?');
    expect(phase3Migration).toContain('ADD COLUMN IF NOT EXISTS "requireMfa" BOOLEAN NOT NULL DEFAULT false');
    expect(phase3Migration).not.toContain('DROP COLUMN');
    expect(phase3Migration).not.toContain('DELETE FROM');
  });
});
