import { describe, it, expect } from 'vitest';
import { BlogAuthorityType, BlogSourceType, BlogResearchSourceCategory } from '@prisma/client';
import { classifySource } from './research-source-classifier';

describe('classifySource', () => {
  it('classifies an approved-corpus source regardless of its sourceType/authorityType', () => {
    const result = classifySource({
      sourceType: BlogSourceType.THIRD_PARTY,
      authorityType: BlogAuthorityType.OTHER,
      isApprovedCorpus: true,
      isAvailable: true,
    });
    expect(result.category).toBe(BlogResearchSourceCategory.APPROVED_CORPUS);
  });

  it('classifies a GAZETTE authority as LEGISLATION', () => {
    const result = classifySource({
      sourceType: BlogSourceType.OFFICIAL,
      authorityType: BlogAuthorityType.GAZETTE,
      isAvailable: true,
    });
    expect(result.category).toBe(BlogResearchSourceCategory.LEGISLATION);
  });

  it('classifies a LEGAL_DATABASE authority as OFFICIAL_GUIDANCE', () => {
    const result = classifySource({
      sourceType: BlogSourceType.OFFICIAL,
      authorityType: BlogAuthorityType.LEGAL_DATABASE,
      isAvailable: true,
    });
    expect(result.category).toBe(BlogResearchSourceCategory.OFFICIAL_GUIDANCE);
  });

  it('classifies an OFFICIAL source from a regulator authority as OFFICIAL_REGULATOR', () => {
    const result = classifySource({
      sourceType: BlogSourceType.OFFICIAL,
      authorityType: BlogAuthorityType.CENTRAL_BANK,
      isAvailable: true,
    });
    expect(result.category).toBe(BlogResearchSourceCategory.OFFICIAL_REGULATOR);
    expect(result.trustLevel).toBe(90);
  });

  it('classifies an INTERNATIONAL_STANDARD source as OFFICIAL_GUIDANCE', () => {
    const result = classifySource({
      sourceType: BlogSourceType.INTERNATIONAL_STANDARD,
      authorityType: BlogAuthorityType.INTERNATIONAL_STANDARD,
      isAvailable: true,
    });
    expect(result.category).toBe(BlogResearchSourceCategory.OFFICIAL_GUIDANCE);
  });

  it('classifies an INDUSTRY_BODY authority as INDUSTRY_SOURCE', () => {
    const result = classifySource({
      sourceType: BlogSourceType.THIRD_PARTY,
      authorityType: BlogAuthorityType.INDUSTRY_BODY,
      isAvailable: true,
    });
    expect(result.category).toBe(BlogResearchSourceCategory.INDUSTRY_SOURCE);
  });

  it('classifies an INTERNAL source as COMPANY_SOURCE', () => {
    const result = classifySource({
      sourceType: BlogSourceType.INTERNAL,
      authorityType: BlogAuthorityType.INTERNAL,
      isAvailable: true,
    });
    expect(result.category).toBe(BlogResearchSourceCategory.COMPANY_SOURCE);
  });

  it('classifies a MEDIA source as REPUTABLE_NEWS', () => {
    const result = classifySource({
      sourceType: BlogSourceType.MEDIA,
      authorityType: BlogAuthorityType.OTHER,
      isAvailable: true,
    });
    expect(result.category).toBe(BlogResearchSourceCategory.REPUTABLE_NEWS);
  });

  it('classifies an explicitly user-generated source as USER_GENERATED', () => {
    const result = classifySource({
      sourceType: BlogSourceType.THIRD_PARTY,
      authorityType: BlogAuthorityType.OTHER,
      isUserGenerated: true,
      isAvailable: true,
    });
    expect(result.category).toBe(BlogResearchSourceCategory.USER_GENERATED);
  });

  it('classifies an unrecognized THIRD_PARTY/OTHER combination as UNVERIFIED - never guessed up', () => {
    const result = classifySource({
      sourceType: BlogSourceType.THIRD_PARTY,
      authorityType: BlogAuthorityType.OTHER,
      isAvailable: true,
    });
    expect(result.category).toBe(BlogResearchSourceCategory.UNVERIFIED);
  });

  it('a poisoned/unverified source cannot be upgraded to a trusted category by any input flag other than isApprovedCorpus', () => {
    const result = classifySource({
      sourceType: BlogSourceType.THIRD_PARTY,
      authorityType: BlogAuthorityType.OTHER,
      isAvailable: true,
    });
    expect(result.category).toBe(BlogResearchSourceCategory.UNVERIFIED);
    expect(result.trustLevel).toBeLessThan(60);
  });

  it('lowers trustLevel (never the category) when a source is unavailable', () => {
    const available = classifySource({
      sourceType: BlogSourceType.OFFICIAL,
      authorityType: BlogAuthorityType.CENTRAL_BANK,
      isAvailable: true,
    });
    const unavailable = classifySource({
      sourceType: BlogSourceType.OFFICIAL,
      authorityType: BlogAuthorityType.CENTRAL_BANK,
      isAvailable: false,
    });
    expect(unavailable.category).toBe(available.category);
    expect(unavailable.trustLevel).toBeLessThan(available.trustLevel);
  });

  it('never lowers trustLevel below 0', () => {
    const result = classifySource({
      sourceType: BlogSourceType.THIRD_PARTY,
      authorityType: BlogAuthorityType.OTHER,
      isUserGenerated: true,
      isAvailable: false,
    });
    expect(result.trustLevel).toBeGreaterThanOrEqual(0);
  });
});
