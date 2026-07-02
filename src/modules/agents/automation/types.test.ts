import { describe, expect, it } from 'vitest';
import { DEFAULT_USE_CASE, TASK_TYPE_USE_CASE_MAP, mapTaskTypeToUseCase } from './types';

describe('mapTaskTypeToUseCase', () => {
  it("has an explicit map entry for the actual W-CONTENT-02 taskType 'regulatory_content_draft'", () => {
    // Inspects the map directly (not through the coalescing function) so this
    // fails if the explicit entry is ever removed, even though it currently
    // resolves to the same value as the default fallback.
    expect(TASK_TYPE_USE_CASE_MAP.regulatory_content_draft).toBe('analysis');
    expect(Object.prototype.hasOwnProperty.call(TASK_TYPE_USE_CASE_MAP, 'regulatory_content_draft')).toBe(true);
  });

  it("resolves 'regulatory_content_draft' to its mapped useCase via mapTaskTypeToUseCase", () => {
    expect(mapTaskTypeToUseCase('regulatory_content_draft')).toBe('analysis');
  });

  it('falls back to DEFAULT_USE_CASE for an unmapped taskType, via the default branch (no map entry)', () => {
    const unmapped = 'some_future_workflow_task_type';
    expect(Object.prototype.hasOwnProperty.call(TASK_TYPE_USE_CASE_MAP, unmapped)).toBe(false);
    expect(mapTaskTypeToUseCase(unmapped)).toBe(DEFAULT_USE_CASE);
  });
});
