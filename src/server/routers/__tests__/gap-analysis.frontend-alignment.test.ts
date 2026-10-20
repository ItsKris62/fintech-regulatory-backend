import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function frontend(relativePath: string): string {
  const frontendRoot = process.env.SHERIABOT_FRONTEND_ROOT
    ? resolve(process.env.SHERIABOT_FRONTEND_ROOT)
    : resolve(__dirname, '../../../../../fintech-regulatory-platform');
  return readFileSync(resolve(frontendRoot, relativePath), 'utf8');
}

describe('Gap Analysis frontend/server contract alignment', () => {
  const page = frontend('app/(dashboard)/startup/gap-analysis/page.tsx');
  const helper = frontend('lib/gap-analysis-contract.ts');
  const input = frontend('lib/gap-analysis-input.ts');
  const router = readFileSync(resolve(__dirname, '../gap-analysis.router.ts'), 'utf8');

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

  it('polls only fields that exist on the GapAnalysis persistence model', () => {
    const statusProcedure = router.slice(
      router.indexOf('getGapAnalysisStatus:'),
      router.indexOf('getGapAnalysisResult:'),
    );

    expect(statusProcedure).toContain('status: true');
    expect(statusProcedure).toContain('progress: true');
    expect(statusProcedure).not.toContain('currentStage: true');
  });
});
