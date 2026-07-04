import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function src(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('User Provisioning Service - MemberRole dynamic assignment', () => {
  const serviceSrc = src('./userProvisioning.service.ts');

  it('determines role dynamically without hardcoding OWNER', () => {
    expect(serviceSrc).toContain('const orgRole = input.orgRole ?? (input.organizationName ? MemberRole.OWNER : MemberRole.MEMBER);');
  });

  it('assigns the dynamically computed role when upserting the OrganizationMember', () => {
    expect(serviceSrc).toContain('role: orgRole');
  });
});
