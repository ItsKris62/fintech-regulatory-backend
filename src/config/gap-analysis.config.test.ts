import { describe, expect, it } from 'vitest';
import { PILOT_ENTITLEMENT_PROFILES, PLAN_ENTITLEMENTS } from './entitlements.config';
import {
  GAP_ANALYSIS_ALLOWED_FILE_TYPES,
  GAP_ANALYSIS_DEPTH_UNIT_COST,
  GAP_ANALYSIS_MAX_FILE_BYTES,
  GAP_ANALYSIS_PROCESSING_ACK_TEXT,
  GAP_ANALYSIS_PROCESSING_ACK_VERSION,
  getAllowedGapAnalysisDepths,
  getGapAnalysisContract,
  isGapAnalysisDepthAllowed,
  isGapAnalysisFileType,
} from './gap-analysis.config';
import type { EffectivePlan } from '@/types/plan.types';
import { storageConfig } from './storage.config';

const expectedDepths: Record<EffectivePlan, readonly string[]> = {
  FREE: [],
  STARTER: ['quick'],
  GROWTH: ['quick', 'standard'],
  BUSINESS: ['quick', 'standard', 'deep'],
  ENTERPRISE: ['quick', 'standard', 'deep'],
  REGULATOR: [],
  STARTUP: ['quick'],
  FREE_TRIAL: ['quick', 'standard', 'deep'],
};

describe('canonical Gap Analysis plan contract', () => {
  it.each(Object.entries(expectedDepths) as Array<[EffectivePlan, readonly string[]]>)
  ('exposes the canonical depths for %s', (plan, depths) => {
    expect(getAllowedGapAnalysisDepths(plan)).toEqual(depths);
    expect(getGapAnalysisContract(plan)).toMatchObject({
      enabled: PLAN_ENTITLEMENTS[plan].gapAnalysis.limit !== 0,
      usageLimit: plan === 'FREE_TRIAL' ? 5 : PLAN_ENTITLEMENTS[plan].gapAnalysis.limit,
      usagePeriod: plan === 'FREE_TRIAL' ? 'lifetime' : PLAN_ENTITLEMENTS[plan].gapAnalysis.period,
      benchmarkDocuments: PLAN_ENTITLEMENTS[plan].benchmarkDocuments,
      countryLimit: PLAN_ENTITLEMENTS[plan].maxEnabledCountries,
      allowedDepths: depths,
    });
  });

  it('uses effective entitlement overrides for feature and benchmark availability', () => {
    const overridden = {
      ...PLAN_ENTITLEMENTS.ENTERPRISE,
      gapAnalysis: { limit: 12, period: 'month' as const },
      benchmarkDocuments: false,
    };

    expect(getGapAnalysisContract('ENTERPRISE', overridden)).toMatchObject({
      enabled: true,
      usageLimit: 12,
      benchmarkDocuments: false,
    });
  });

  it('keeps active pilot profiles on the Enterprise contract', () => {
    for (const profile of Object.values(PILOT_ENTITLEMENT_PROFILES)) {
      expect(profile.gapAnalysis).toEqual(PLAN_ENTITLEMENTS.ENTERPRISE.gapAnalysis);
      expect(profile.benchmarkDocuments).toBe(true);
      expect(getAllowedGapAnalysisDepths('ENTERPRISE')).toEqual(['quick', 'standard', 'deep']);
    }
  });

  it('authorizes each depth explicitly instead of relying on UI state', () => {
    expect(isGapAnalysisDepthAllowed('STARTER', 'quick')).toBe(true);
    expect(isGapAnalysisDepthAllowed('STARTER', 'standard')).toBe(false);
    expect(isGapAnalysisDepthAllowed('GROWTH', 'standard')).toBe(true);
    expect(isGapAnalysisDepthAllowed('GROWTH', 'deep')).toBe(false);
    expect(isGapAnalysisDepthAllowed('BUSINESS', 'deep')).toBe(true);
  });

  it('keeps the existing commercial usage costs unchanged', () => {
    expect(GAP_ANALYSIS_DEPTH_UNIT_COST).toEqual({ quick: 1, standard: 2, deep: 5 });
  });

  it('binds the canonical processing acknowledgement version to its exact UI wording', () => {
    expect(getGapAnalysisContract('BUSINESS').processingAcknowledgement).toEqual({
      version: GAP_ANALYSIS_PROCESSING_ACK_VERSION,
      text: GAP_ANALYSIS_PROCESSING_ACK_TEXT,
    });
    expect(GAP_ANALYSIS_PROCESSING_ACK_VERSION).toBe('2026-10-01');
    expect(GAP_ANALYSIS_PROCESSING_ACK_TEXT).toBe(
      "I understand that my document may be processed using AI services hosted outside my home jurisdiction, in accordance with SheriaBot's Privacy Policy and applicable data-protection law.",
    );
  });
});

describe('canonical Gap Analysis upload contract', () => {
  it('uses one safe 10 MB binary limit while request transport remains base64', () => {
    expect(GAP_ANALYSIS_MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('supports only formats handled by the full current pipeline', () => {
    expect(GAP_ANALYSIS_ALLOWED_FILE_TYPES.map((type) => type.extension)).toEqual(['pdf', 'docx', 'txt']);
    expect(isGapAnalysisFileType('pdf')).toBe(true);
    expect(isGapAnalysisFileType('docx')).toBe(true);
    expect(isGapAnalysisFileType('txt')).toBe(true);
    expect(isGapAnalysisFileType('doc')).toBe(false);
    expect(isGapAnalysisFileType('exe')).toBe(false);
    expect(storageConfig.allowedFileTypes.gapAnalysis.extensions).toEqual(['.pdf', '.docx', '.txt']);
    expect(storageConfig.limits.maxFileSize.gapAnalysis).toBe(GAP_ANALYSIS_MAX_FILE_BYTES);
  });
});
