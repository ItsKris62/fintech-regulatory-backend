import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function frontend(relativePath: string): string {
  return readFileSync(resolve(__dirname, '../../../../../fintech-regulatory-platform', relativePath), 'utf8');
}

describe('Gap Analysis frontend/server contract alignment', () => {
  const page = frontend('app/(dashboard)/startup/gap-analysis/page.tsx');
  const helper = frontend('lib/gap-analysis-contract.ts');
  const input = frontend('lib/gap-analysis-input.ts');

  it('drives depth authorization and defaults from the backend limits response', () => {
    expect(page).toContain('gapLimits?.allowedDepths');
    expect(page).toContain('selectGapAnalysisDepth');
    expect(page).toContain('disabled={!isAllowed}');
    expect(page).not.toContain('useState<GapAnalysisDepth>("standard")');
  });

  it('does not fetch or enable benchmark selection without backend entitlement', () => {
    expect(page).toContain('gapLimits?.benchmarkDocuments === true');
    expect(page).toContain('gapLimits.benchmarkDocuments');
  });

  it('derives upload validation and helper text from the backend response', () => {
    expect(page).toContain('maxFileSizeBytes: gapLimits.maxFileSizeBytes');
    expect(page).toContain('allowedFileTypes: gapLimits.allowedFileTypes');
    expect(page).not.toContain('const MAX_FILE_SIZE');
    expect(helper).toContain('validateGapAnalysisFile');
    expect(input).not.toContain('"doc"');
  });
});
