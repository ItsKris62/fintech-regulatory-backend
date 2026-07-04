import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function src(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('Organization Router - getMembers role map', () => {
  const routerSrc = src('organization.router.ts');

  it('queries from organizationMember directly instead of user table', () => {
    expect(routerSrc).toContain('ctx.prisma.organizationMember.findMany');
    expect(routerSrc).toContain('ctx.prisma.organizationMember.count');
  });

  it('correctly aliases platformRole and maps the org role', () => {
    expect(routerSrc).toContain('platformRole: m.user.role');
    expect(routerSrc).toContain('orgRole: m.role');
    expect(routerSrc).toContain('joinedAt: m.createdAt');
  });
});
