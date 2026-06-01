import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('compliance stream free-trial quota gate', () => {
  const source = readFileSync(resolve(__dirname, 'compliance-stream.route.ts'), 'utf8');

  it('atomically consumes the compliance query slot before allowing stream work', () => {
    const atomicIncrementIndex = source.indexOf(
      "incrementTrialUsageAtomic(auth.userId, 'complianceQueries', 1)",
    );
    const allowedResponseIndex = source.indexOf('allowed: true', atomicIncrementIndex);

    expect(atomicIncrementIndex).toBeGreaterThan(-1);
    expect(allowedResponseIndex).toBeGreaterThan(atomicIncrementIndex);
  });

  it('does not defer free-trial compliance query increments to stream completion', () => {
    expect(source).not.toContain("const queryCheck = await checkTrialLimit(auth.userId, 'complianceQueries')");
  });
});
