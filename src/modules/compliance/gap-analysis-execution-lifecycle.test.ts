import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GAP_ANALYSIS_REUSABLE_EXECUTION_STATUSES } from './gap-analysis-execution-identity';

const migrationPath = path.resolve(
  process.cwd(),
  'prisma/migrations/20261012000000_gap_analysis_execution_identity/migration.sql',
);

describe('Gap Analysis execution reservation lifecycle', () => {
  it('keeps the application reservation statuses aligned with the partial unique index', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    for (const status of GAP_ANALYSIS_REUSABLE_EXECUTION_STATUSES) {
      expect(sql).toContain(`'${status}'`);
    }
    for (const rerunnable of ['FAILED', 'CANCELLED', 'DEAD_LETTERED']) {
      expect(sql).not.toMatch(new RegExp(`status.*${rerunnable}`, 'i'));
    }
    expect(sql).toContain('"deletedAt" IS NULL');
    expect(sql).toContain('"executionIdentity" IS NOT NULL');
  });
});
