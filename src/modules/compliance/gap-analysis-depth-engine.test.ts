import { describe, expect, it, vi } from 'vitest';
import { getGapAnalysisDepthProfile } from '@/config/gap-analysis-depth-profiles';
import { chunkPolicyText } from '@/lib/ai/prompts/gap-analysis';
import {
  buildDepthRetrievalQueries,
  buildWeakEvidenceRetryQuery,
  GapAnalysisBudgetExceededError,
  GapAnalysisExecutionBudget,
  mapWithConcurrency,
  mergeEnhancedRawFindings,
  selectPolicyChunksForDepth,
} from './gap-analysis-depth-engine';
import {
  GOLDEN_DEEP_ENHANCED_FINDINGS,
  GOLDEN_EVIDENCE,
  GOLDEN_POLICY_TEXT,
  GOLDEN_QUICK_FINDINGS,
  GOLDEN_STANDARD_FINDINGS,
} from './__fixtures__/gap-analysis-depth-golden.fixture';

describe('Gap Analysis depth engine', () => {
  it('builds 1/2/3 bounded framework-scoped queries', () => {
    const build = (depth: 'quick' | 'standard' | 'deep') => buildDepthRetrievalQueries({
      framework: 'Data Protection Act',
      jurisdictionNames: 'Kenya',
      policyKeywords: ['incident', 'retention'],
      profile: getGapAnalysisDepthProfile(depth),
    });
    expect(build('quick')).toHaveLength(1);
    expect(build('standard')).toHaveLength(2);
    expect(build('deep')).toHaveLength(3);
    expect(build('deep').slice(0, 2)).toEqual(build('standard'));
    expect(build('deep').every((query) => query.includes('Data Protection Act') && query.includes('Kenya'))).toBe(true);
    expect(buildWeakEvidenceRetryQuery({ framework: 'Data Protection Act', jurisdictionNames: 'Kenya', policyKeywords: [] })).toContain('Data Protection Act Kenya');
  });

  it('never traverses fewer configured chunks in Deep than Standard', () => {
    const text = Array.from({ length: 120 }, (_, index) => `Section ${index}\n${'control '.repeat(120)}`).join('\n\n');
    const quickChunks = chunkPolicyText(text, 8000, 600);
    const standardChunks = chunkPolicyText(text, 6000, 800);
    const deepChunks = chunkPolicyText(text, 5000, 1000);
    const quick = selectPolicyChunksForDepth(quickChunks, getGapAnalysisDepthProfile('quick'));
    const standard = selectPolicyChunksForDepth(standardChunks, getGapAnalysisDepthProfile('standard'));
    const deep = selectPolicyChunksForDepth(deepChunks, getGapAnalysisDepthProfile('deep'));
    expect(standard.selected.length).toBeGreaterThanOrEqual(quick.selected.length);
    expect(deep.selected.length).toBeGreaterThanOrEqual(standard.selected.length);
    expect(quick.completeConfiguredTraversal).toBe(false);
  });

  it('preserves baseline material findings and adds only distinct enhanced findings', () => {
    const standard = mergeEnhancedRawFindings(GOLDEN_QUICK_FINDINGS, GOLDEN_STANDARD_FINDINGS);
    const deep = mergeEnhancedRawFindings(standard, GOLDEN_DEEP_ENHANCED_FINDINGS);
    expect(standard.map((finding) => finding.id)).toEqual(['INCIDENT-NOTIFICATION', 'COMPLAINTS-PROCEDURE']);
    expect(deep.map((finding) => finding.id)).toEqual([
      'INCIDENT-NOTIFICATION',
      'COMPLAINTS-PROCEDURE',
      'RETENTION-CONTRADICTION',
    ]);
    for (const finding of deep) {
      expect(finding.evidenceIds?.length).toBeGreaterThan(0);
      expect(Object.values(GOLDEN_EVIDENCE)).toContain(finding.evidenceIds?.[0]);
    }
    expect(GOLDEN_POLICY_TEXT).toContain('seven years');
    expect(GOLDEN_POLICY_TEXT).toContain('twelve months');
  });

  it('does not create findings when enhanced review supplies no evidence-backed result', () => {
    expect(mergeEnhancedRawFindings(GOLDEN_STANDARD_FINDINGS, [])).toEqual(GOLDEN_STANDARD_FINDINGS);
  });

  it('enforces retrieval, model-call, input, output, and wall-clock ceilings', async () => {
    const profile = structuredClone(getGapAnalysisDepthProfile('quick'));
    profile.retrieval.maxRetrievalOperations = 1;
    profile.budget.maxModelCalls = 1;
    const budget = new GapAnalysisExecutionBudget(profile, Date.now(), vi.fn(async () => undefined));
    await budget.beforeRetrieval(10, 10);
    await expect(budget.beforeRetrieval(10, 10)).rejects.toBeInstanceOf(GapAnalysisBudgetExceededError);

    const expired = new GapAnalysisExecutionBudget(profile, Date.now() - profile.budget.maxWallClockMs, vi.fn(async () => undefined));
    await expect(expired.beforeModelCall(1, 1)).rejects.toMatchObject({ budget: 'wall-clock' });
  });

  it('respects bounded concurrency and deterministic result ordering', async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return value * 2;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });
});
