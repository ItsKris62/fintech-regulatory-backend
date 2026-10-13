import { describe, expect, it } from 'vitest';
import { SourceInsufficiencyError } from '@/lib/source-grounding/source-insufficiency';
import { GapAnalysisCancelledError } from './gap-analysis-cancellation';
import { classifyGapAnalysisFailure } from './gap-analysis-observability';

describe('Gap Analysis failure taxonomy', () => {
  it('keeps source insufficiency non-retryable', () => {
    expect(classifyGapAnalysisFailure(new SourceInsufficiencyError('insufficient'))).toEqual({
      failureClass: 'SOURCE_INSUFFICIENCY', retryable: false,
    });
  });

  it('normalizes cancellation and timeout without serializing the error', () => {
    expect(classifyGapAnalysisFailure(new GapAnalysisCancelledError())).toEqual({ failureClass: 'CANCELLED', retryable: false });
    expect(classifyGapAnalysisFailure(new Error('execution deadline reached'))).toEqual({ failureClass: 'TIMEOUT', retryable: true });
  });
});
