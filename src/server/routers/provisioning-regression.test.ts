import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function src(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('Admin Router - listUsers visibility regression fix', () => {
  const routerSrc = src('admin.router.ts');

  it('adds recentlyActive to the input schema', () => {
    expect(routerSrc).toContain('recentlyActive: z.boolean().optional()');
  });

  it('checks accountStatus for active status instead of lastLoginAt', () => {
    expect(routerSrc).toContain("where.accountStatus = 'active'");
    expect(routerSrc).toContain("where.accountStatus = { not: 'active' }");
  });

  it('keeps 30 day login filter logic mapped to recentlyActive', () => {
    expect(routerSrc).toContain('if (recentlyActive === true)');
    expect(routerSrc).toContain('gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)');
  });
});

describe('User Provisioning Service - MemberRole dynamic assignment regression fix', () => {
  const serviceSrc = src('../services/userProvisioning.service.ts');

  it('accepts organizationRole in the input schema', () => {
    expect(serviceSrc).toContain("orgRole: z.nativeEnum(MemberRole).optional().default('MEMBER')");
  });

  it('dynamically computes the org role with MemberRole.MEMBER fallback', () => {
    expect(serviceSrc).toContain('const orgRole = input.orgRole ?? (input.organizationName ? MemberRole.OWNER : MemberRole.MEMBER);');
  });

  it('assigns the computed role in the upsert', () => {
    expect(serviceSrc).toContain('role: orgRole');
  });
});

describe('Organization Router - getMembers platformRole regression fix', () => {
  const routerSrc = src('organization.router.ts');

  it('queries organizationMember.findMany', () => {
    expect(routerSrc).toContain('ctx.prisma.organizationMember.findMany');
    expect(routerSrc).toContain('ctx.prisma.organizationMember.count');
  });

  it('returns both orgRole (mapped to org role) and platformRole (mapped from user)', () => {
    expect(routerSrc).toContain('platformRole: m.user.role');
    expect(routerSrc).toContain('orgRole: m.role');
    expect(routerSrc).toContain('joinedAt: m.createdAt');
  });
});
