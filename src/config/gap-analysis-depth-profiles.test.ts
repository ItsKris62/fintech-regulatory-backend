import { describe, expect, it } from 'vitest';
import { GAP_ANALYSIS_DEPTH_UNIT_COST, getGapAnalysisContract } from './gap-analysis.config';
import {
  GAP_ANALYSIS_DEPTH_PROFILES,
  GAP_ANALYSIS_EXECUTION_PROFILE_VERSION,
  buildGapAnalysisDepthDedupeScope,
  getGapAnalysisDepthProfile,
} from './gap-analysis-depth-profiles';

describe('Gap Analysis depth execution profiles', () => {
  it.each(['quick', 'standard', 'deep'] as const)('resolves %s to one canonical versioned profile', (depth) => {
    expect(getGapAnalysisDepthProfile(depth)).toBe(GAP_ANALYSIS_DEPTH_PROFILES[depth]);
    expect(getGapAnalysisDepthProfile(depth).depth).toBe(depth);
    expect(GAP_ANALYSIS_EXECUTION_PROFILE_VERSION).toBe('gap-analysis-depth-v2');
  });

  it('uses materially distinct operational configuration', () => {
    const quick = getGapAnalysisDepthProfile('quick');
    const standard = getGapAnalysisDepthProfile('standard');
    const deep = getGapAnalysisDepthProfile('deep');
    expect([quick.retrieval.queriesPerFramework, standard.retrieval.queriesPerFramework, deep.retrieval.queriesPerFramework]).toEqual([1, 2, 3]);
    expect([quick.retrieval.topK, standard.retrieval.topK, deep.retrieval.topK]).toEqual([4, 8, 12]);
    expect([quick.document.maxChunks, standard.document.maxChunks, deep.document.maxChunks]).toEqual([4, 12, 20]);
    expect(deep.document.chunkSize).toBe(standard.document.chunkSize);
    expect(deep.document.chunkOverlap).toBe(standard.document.chunkOverlap);
    expect([quick.analysis.passes, standard.analysis.passes, deep.analysis.passes]).toEqual([1, 1, 2]);
    expect(deep.analysis.contradictionReview).toBe(true);
    expect(standard.verification.secondaryReview).toBe(true);
    expect(standard.verification.mode).toBe('SECONDARY_WEAK_FINDING_REVIEW');
    expect(deep.verification.secondaryReview).toBe(true);
  });

  it('keeps traversal and every aggregate resource ceiling monotonic and finite', () => {
    const profiles = (['quick', 'standard', 'deep'] as const).map(getGapAnalysisDepthProfile);
    for (let index = 1; index < profiles.length; index++) {
      expect(profiles[index].document.maxChunks).toBeGreaterThanOrEqual(profiles[index - 1].document.maxChunks);
      expect(profiles[index].budget.maxModelCalls).toBeGreaterThan(profiles[index - 1].budget.maxModelCalls);
      expect(profiles[index].budget.maxInputTokens).toBeGreaterThan(profiles[index - 1].budget.maxInputTokens);
      expect(profiles[index].budget.maxOutputTokens).toBeGreaterThan(profiles[index - 1].budget.maxOutputTokens);
    }
    for (const profile of profiles) {
      expect(Number.isFinite(profile.budget.maxWallClockMs)).toBe(true);
      expect(profile.document.concurrency).toBe(1);
      expect(profile.retrieval.concurrency).toBeLessThanOrEqual(3);
    }
  });

  it('preserves 1/2/5 usage and plan authorization while exposing canonical product copy', () => {
    expect(GAP_ANALYSIS_DEPTH_UNIT_COST).toEqual({ quick: 1, standard: 2, deep: 5 });
    expect(getGapAnalysisContract('STARTER').allowedDepths).toEqual(['quick']);
    expect(getGapAnalysisContract('GROWTH').allowedDepths).toEqual(['quick', 'standard']);
    expect(getGapAnalysisContract('BUSINESS').allowedDepths).toEqual(['quick', 'standard', 'deep']);
    expect(getGapAnalysisContract('BUSINESS').depthOptions.map(({ depth, units }) => ({ depth, units }))).toEqual([
      { depth: 'quick', units: 1 },
      { depth: 'standard', units: 2 },
      { depth: 'deep', units: 5 },
    ]);
    expect(getGapAnalysisContract('BUSINESS').depthOptions.some((option) => /complete legal audit|guaranteed|100%/i.test(option.description))).toBe(false);
  });

  it('keeps Quick, Standard, and Deep in independent versioned dedupe identities', () => {
    const base = {
      organizationId: 'org-1',
      jurisdictionCode: 'KE',
      frameworks: ['framework-b', 'framework-a'],
      benchmarkDocumentIds: ['benchmark-1'],
      focusAreas: ['incident response'],
    } as const;
    const quick = buildGapAnalysisDepthDedupeScope({ ...base, analysisDepth: 'quick' });
    const standard = buildGapAnalysisDepthDedupeScope({ ...base, analysisDepth: 'standard' });
    const deep = buildGapAnalysisDepthDedupeScope({ ...base, analysisDepth: 'deep' });
    expect(new Set([quick, standard, deep])).toHaveLength(3);
    expect(JSON.parse(deep)).toMatchObject({
      analysisDepth: 'deep',
      executionProfileVersion: GAP_ANALYSIS_EXECUTION_PROFILE_VERSION,
      frameworks: ['framework-a', 'framework-b'],
    });
  });
});
