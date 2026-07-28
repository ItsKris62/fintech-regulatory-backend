import { BlogAuthorityType, BlogResearchSourceCategory, BlogSourceType } from '@prisma/client';

/**
 * Deterministic source-trust classifier for Stage C7 research packs. Runs
 * BEFORE the AI synthesis call - the AI is never given the opportunity to
 * assign or upgrade a source's category or trust level; it only ever
 * references sources by the stable `sourceRef` this classifier (indirectly,
 * via the caller) assigns. See phase-b-data-model.md §2 and
 * research-pack-policy.md for the full rationale and category definitions.
 */

export interface ClassifiableSource {
  sourceType?: BlogSourceType | null;
  authorityType?: BlogAuthorityType | null;
  /** True only when the source is SheriaBot's own vetted legal corpus - an explicit designation, never inferred. */
  isApprovedCorpus?: boolean;
  /** True only when the source was explicitly submitted by an end user rather than the monitored pipeline. */
  isUserGenerated?: boolean;
  isAvailable: boolean;
}

export interface SourceClassification {
  category: BlogResearchSourceCategory;
  trustLevel: number;
}

const REGULATOR_AUTHORITY_TYPES: readonly BlogAuthorityType[] = [
  BlogAuthorityType.CENTRAL_BANK,
  BlogAuthorityType.DATA_PROTECTION,
  BlogAuthorityType.AML_CFT,
  BlogAuthorityType.COMMUNICATIONS,
  BlogAuthorityType.SECURITIES,
  BlogAuthorityType.CONSUMER_PROTECTION,
  BlogAuthorityType.COMPETITION,
  BlogAuthorityType.DEVELOPMENT_FINANCE,
];

const UNAVAILABLE_TRUST_PENALTY = 20;
const MIN_TRUST_LEVEL = 0;

function baseTrustLevel(category: BlogResearchSourceCategory): number {
  switch (category) {
    case BlogResearchSourceCategory.APPROVED_CORPUS:
      return 95;
    case BlogResearchSourceCategory.LEGISLATION:
      return 95;
    case BlogResearchSourceCategory.OFFICIAL_REGULATOR:
      return 90;
    case BlogResearchSourceCategory.OFFICIAL_GUIDANCE:
      return 80;
    case BlogResearchSourceCategory.INDUSTRY_SOURCE:
      return 60;
    case BlogResearchSourceCategory.COMPANY_SOURCE:
      return 55;
    case BlogResearchSourceCategory.REPUTABLE_NEWS:
      return 50;
    case BlogResearchSourceCategory.USER_GENERATED:
      return 20;
    case BlogResearchSourceCategory.UNVERIFIED:
      return 30;
  }
}

/**
 * Deterministic, precedence-ordered classification. Each rule is evaluated in
 * order and the first match wins - a source can only ever fall through to a
 * lower-trust category, never be upgraded by anything the AI later says.
 */
export function classifySource(source: ClassifiableSource): SourceClassification {
  let category: BlogResearchSourceCategory;

  if (source.isApprovedCorpus) {
    category = BlogResearchSourceCategory.APPROVED_CORPUS;
  } else if (source.authorityType === BlogAuthorityType.GAZETTE) {
    category = BlogResearchSourceCategory.LEGISLATION;
  } else if (source.authorityType === BlogAuthorityType.LEGAL_DATABASE) {
    category = BlogResearchSourceCategory.OFFICIAL_GUIDANCE;
  } else if (source.sourceType === BlogSourceType.OFFICIAL && source.authorityType && REGULATOR_AUTHORITY_TYPES.includes(source.authorityType)) {
    category = BlogResearchSourceCategory.OFFICIAL_REGULATOR;
  } else if (source.sourceType === BlogSourceType.INTERNATIONAL_STANDARD || source.authorityType === BlogAuthorityType.INTERNATIONAL_STANDARD) {
    category = BlogResearchSourceCategory.OFFICIAL_GUIDANCE;
  } else if (source.authorityType === BlogAuthorityType.INDUSTRY_BODY) {
    category = BlogResearchSourceCategory.INDUSTRY_SOURCE;
  } else if (source.sourceType === BlogSourceType.INTERNAL || source.authorityType === BlogAuthorityType.INTERNAL) {
    category = BlogResearchSourceCategory.COMPANY_SOURCE;
  } else if (source.sourceType === BlogSourceType.MEDIA) {
    category = BlogResearchSourceCategory.REPUTABLE_NEWS;
  } else if (source.isUserGenerated) {
    category = BlogResearchSourceCategory.USER_GENERATED;
  } else {
    // BlogSourceType.THIRD_PARTY, BlogAuthorityType.OTHER, or any combination
    // not otherwise recognized - conservatively unverified, never guessed up.
    category = BlogResearchSourceCategory.UNVERIFIED;
  }

  let trustLevel = baseTrustLevel(category);
  if (!source.isAvailable) {
    trustLevel = Math.max(MIN_TRUST_LEVEL, trustLevel - UNAVAILABLE_TRUST_PENALTY);
  }

  return { category, trustLevel };
}
