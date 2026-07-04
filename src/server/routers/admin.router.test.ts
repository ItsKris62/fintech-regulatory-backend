import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function src(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('Admin Router Visibility - listUsers', () => {
  const routerSrc = src('admin.router.ts');

  it('filters active status using accountStatus instead of lastLoginAt', () => {
    expect(routerSrc).toContain("where.accountStatus = 'active'");
    expect(routerSrc).toContain("where.accountStatus = { not: 'active' }");
  });

  it('allows filtering by recentlyActive for 30-day login window', () => {
    expect(routerSrc).toContain('if (recentlyActive === true)');
    expect(routerSrc).toContain('gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)');
  });
});
