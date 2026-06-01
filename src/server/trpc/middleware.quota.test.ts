import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('usage quota middleware', () => {
  const source = readFileSync(resolve(__dirname, 'middleware.ts'), 'utf8');

  it('enforces Redis-backed plan quotas at atomic increment time', () => {
    expect(source).toContain('const newCount = await redis.incr(usageKey);');
    expect(source).toContain('if (newCount > limit)');
    expect(source).toContain('await redis.decr(usageKey);');
    expect(source).toContain('usage_limit_reached_atomic');
  });
});
