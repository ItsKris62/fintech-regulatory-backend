import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('authorization audit logging', () => {
  const source = readFileSync(resolve(__dirname, 'middleware.ts'), 'utf8');

  it('does not sample successful organization membership grants', () => {
    const grantIndex = source.indexOf("action:     'authorization.granted'");

    expect(grantIndex).toBeGreaterThan(-1);
    expect(source).not.toContain('AUDIT_GRANT_SAMPLE_RATE');
    expect(source).not.toContain('Math.random() <');
  });

  it('writes successful grants to AuditLog before continuing the request', () => {
    const grantIndex = source.indexOf("action:     'authorization.granted'");
    const nextIndex = source.indexOf('return next({ ctx: { ...ctx, orgMembership: entry } });');

    expect(grantIndex).toBeGreaterThan(-1);
    expect(nextIndex).toBeGreaterThan(grantIndex);
  });
});
