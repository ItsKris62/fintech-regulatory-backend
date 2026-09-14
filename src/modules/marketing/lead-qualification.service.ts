/**
 * Lead Qualification Service (P0)
 *
 * Implements deterministic 100-point ICP qualification, regulatory exposure scoring,
 * hard exclusions, and evidence hashing for AI-discovered leads.
 *
 * Scoring Formula (Max 100):
 *   S = S_reg (30) + S_fit (20) + S_comp (15) + S_size (10) + S_buyer (10) + S_trig (5) + S_conf (10)
 *
 * Deterministic Score-to-State Mapping:
 *   80 - 100: Priority HOT    -> PENDING_REVIEW
 *   65 - 79:  Priority STRONG -> PENDING_REVIEW
 *   50 - 64:  Priority NURTURE-> NURTURE
 *   Below 50: Rejected       -> REJECTED
 */

import { createHash } from 'crypto';
import { IcpTier, LeadStatus, CompanySizeClass } from '@prisma/client';

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export interface CandidateLeadInput {
  name: string;
  domain?: string | null;
  country?: string;
  industry?: string | null;
  regulatoryBody?: string | null;
  licenceType?: string | null;
  licenceNumber?: string | null;
  licenceStatus?: string | null;
  sizeClass?: CompanySizeClass | null;
  employeeCount?: number | null;
  
  // Fit signals
  hasComplianceObligation?: boolean;
  operatesCrossBorder?: boolean;
  handlesPersonalData?: boolean;
  handlesCustomerFunds?: boolean;
  
  // Buyer accessibility
  hasNamedBuyerContact?: boolean;
  buyerRoleIdentified?: boolean;
  targetRoleTitle?: string | null;

  // Regulatory Triggers
  recentRegulatoryEvent?: boolean;
  recentLicensingDeadline?: boolean;

  // Extraction Confidence (0.0 to 1.0)
  confidence?: number;
}

export interface HardExclusionResult {
  isExcluded: boolean;
  reason?: 'EXISTING_CUSTOMER' | 'REJECTED_UNSUPPORTED_COUNTRY' | 'REJECTED_BANNED_REVOKED' | 'EXCLUDED_DO_NOT_CONTACT';
  targetStatus: LeadStatus;
}

export interface ScoreBreakdown {
  regulatoryExposure: number; // Max 30
  sheriaBotFit: number;       // Max 20
  complexity: number;         // Max 15
  companySize: number;        // Max 10
  buyerAccessibility: number; // Max 10
  regulatoryTrigger: number;  // Max 5
  confidenceAdjustment: number;// Max 10
  totalScore: number;         // 0 - 100
}

export interface QualificationResult {
  isExcluded: boolean;
  exclusionReason?: string;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  icpTier: IcpTier;
  leadStatus: LeadStatus;
  priority: 'HOT' | 'STRONG' | 'NURTURE' | 'DISQUALIFIED';
  reviewReason?: string;
  rejectionReason?: string;
}

// ---------------------------------------------------------------------------
// Supported Jurisdictions & Regulators
// ---------------------------------------------------------------------------

export const SUPPORTED_COUNTRIES = new Set(['Kenya', 'Rwanda', 'Malawi', 'Nigeria', 'KE', 'RW', 'MW', 'NG']);

export const CORE_REGULATORS_KE = new Set([
  'CBK', 'CENTRAL BANK OF KENYA',
  'CMA', 'CAPITAL MARKETS AUTHORITY',
  'ODPC', 'OFFICE OF THE DATA PROTECTION COMMISSIONER',
  'IRA', 'INSURANCE REGULATORY AUTHORITY',
  'SASRA', 'SACCO SOCIETIES REGULATORY AUTHORITY',
  'FRC', 'FINANCIAL REPORTING CENTRE',
  'CAK', 'COMPETITION AUTHORITY OF KENYA',
]);

// ---------------------------------------------------------------------------
// Evidence Hash Calculation (Amendment 3)
// ---------------------------------------------------------------------------

/**
 * Computes a deterministic SHA-256 hash for evidence deduplication and replay safety.
 */
export function computeEvidenceHash(params: {
  companyIdentifier: string; // companyId or candidate domain/name
  field: string;
  normalizedValue: string;
  sourceUrl: string;
  sourceRecordId?: string | null;
}): string {
  const normField = params.field.trim().toLowerCase();
  const normVal = params.normalizedValue.trim().toLowerCase();
  const normUrl = params.sourceUrl.trim().toLowerCase();
  const normRec = (params.sourceRecordId || '').trim().toLowerCase();
  const normId = params.companyIdentifier.trim().toLowerCase();

  const payload = `${normId}|${normField}|${normVal}|${normUrl}|${normRec}`;
  return createHash('sha256').update(payload).digest('hex');
}

// ---------------------------------------------------------------------------
// Hard Exclusion Evaluator
// ---------------------------------------------------------------------------

export function evaluateHardExclusions(params: {
  candidate: CandidateLeadInput;
  isExistingCustomer?: boolean;
  isDoNotContact?: boolean;
}): HardExclusionResult {
  // 1. Existing Paying Customer
  if (params.isExistingCustomer) {
    return {
      isExcluded: true,
      reason: 'EXISTING_CUSTOMER',
      targetStatus: LeadStatus.CONVERTED,
    };
  }

  // 2. Do Not Contact / Blacklisted
  if (params.isDoNotContact || params.candidate.licenceStatus?.toUpperCase() === 'DO_NOT_CONTACT') {
    return {
      isExcluded: true,
      reason: 'EXCLUDED_DO_NOT_CONTACT',
      targetStatus: LeadStatus.DO_NOT_CONTACT,
    };
  }

  // 3. Unsupported Country (P0 Kenya priority + expansion countries)
  const country = params.candidate.country?.trim() || 'Kenya';
  if (!SUPPORTED_COUNTRIES.has(country)) {
    return {
      isExcluded: true,
      reason: 'REJECTED_UNSUPPORTED_COUNTRY',
      targetStatus: LeadStatus.REJECTED,
    };
  }

  // 4. Banned / Revoked Licence
  const licenceStatus = params.candidate.licenceStatus?.trim().toUpperCase();
  if (licenceStatus === 'REVOKED' || licenceStatus === 'BANNED' || licenceStatus === 'CANCELLED' || licenceStatus === 'BLACK_LISTED') {
    return {
      isExcluded: true,
      reason: 'REJECTED_BANNED_REVOKED',
      targetStatus: LeadStatus.REJECTED,
    };
  }

  return { isExcluded: false, targetStatus: LeadStatus.DISCOVERED };
}

// ---------------------------------------------------------------------------
// ICP Tier Determination
// ---------------------------------------------------------------------------

export function determineIcpTier(candidate: CandidateLeadInput): IcpTier {
  const regBody = (candidate.regulatoryBody || '').toUpperCase();
  const licenceType = (candidate.licenceType || '').toUpperCase();
  const industry = (candidate.industry || '').toUpperCase();

  // Tier 1: Core Fintech (Direct CBK oversight / high regulatory impact)
  if (
    regBody.includes('CBK') ||
    licenceType.includes('DIGITAL CREDIT') ||
    licenceType.includes('DCP') ||
    licenceType.includes('PAYMENT SERVICE') ||
    licenceType.includes('PSP') ||
    licenceType.includes('MONEY REMITTANCE') ||
    industry.includes('DIGITAL LENDING') ||
    industry.includes('PAYMENTS') ||
    industry.includes('NEOBANK')
  ) {
    return IcpTier.TIER_1_CORE_FINTECH;
  }

  // Tier 2: High Exposure (CMA intermediaries, SASRA SACCOs, Insurtech, ODPC data-heavy)
  if (
    regBody.includes('CMA') ||
    regBody.includes('SASRA') ||
    regBody.includes('IRA') ||
    regBody.includes('ODPC') ||
    licenceType.includes('INVESTMENT') ||
    licenceType.includes('SACCO') ||
    licenceType.includes('INSURTECH') ||
    industry.includes('WEALTHTECH') ||
    industry.includes('CAPITAL MARKETS') ||
    industry.includes('INSURANCE')
  ) {
    return IcpTier.TIER_2_HIGH_EXPOSURE;
  }

  // Tier 3: Adjacent (B2B SaaS to finance, Credit Bureaus, Tech Enablers)
  if (
    regBody.includes('CAK') ||
    industry.includes('CREDIT SCORING') ||
    industry.includes('FINANCIAL SOFTWARE') ||
    industry.includes('IDENTITY') ||
    industry.includes('KYC')
  ) {
    return IcpTier.TIER_3_ADJACENT;
  }

  // Non-ICP
  return IcpTier.NON_ICP;
}

// ---------------------------------------------------------------------------
// 100-Point Deterministic Score Calculator
// ---------------------------------------------------------------------------

export function calculateLeadScore(candidate: CandidateLeadInput, icpTier: IcpTier): ScoreBreakdown {
  // 1. Regulatory Exposure (Max 30)
  let regulatoryExposure = 0;
  if (icpTier === IcpTier.TIER_1_CORE_FINTECH) {
    regulatoryExposure = 30;
  } else if (icpTier === IcpTier.TIER_2_HIGH_EXPOSURE) {
    regulatoryExposure = 22;
  } else if (icpTier === IcpTier.TIER_3_ADJACENT) {
    regulatoryExposure = 12;
  } else {
    regulatoryExposure = 0;
  }

  // 2. SheriaBot Product Fit (Max 20)
  let sheriaBotFit = 0;
  if (candidate.hasComplianceObligation) sheriaBotFit += 8;
  if (candidate.handlesPersonalData) sheriaBotFit += 6;
  if (candidate.handlesCustomerFunds) sheriaBotFit += 6;
  sheriaBotFit = Math.min(20, sheriaBotFit);

  // 3. Operational & Regulatory Complexity (Max 15)
  let complexity = 0;
  if (candidate.operatesCrossBorder) complexity += 8;
  if (candidate.licenceNumber) complexity += 7; // Has formal license registered
  complexity = Math.min(15, complexity);

  // 4. Company Size Class / Team Capacity (Max 10)
  let companySize = 0;
  const size = candidate.sizeClass || CompanySizeClass.UNKNOWN;
  if (size === CompanySizeClass.MEDIUM || size === CompanySizeClass.LARGE) {
    companySize = 10;
  } else if (size === CompanySizeClass.SMALL) {
    companySize = 8;
  } else if (size === CompanySizeClass.ENTERPRISE) {
    companySize = 7;
  } else if (size === CompanySizeClass.MICRO) {
    companySize = 4;
  } else {
    companySize = 3; // UNKNOWN default base
  }

  // 5. Buyer Accessibility (Max 10) - strictly verified (Amendment 15)
  let buyerAccessibility = 0;
  if (candidate.hasNamedBuyerContact) {
    buyerAccessibility = 10; // Verified named buyer contact exists
  } else if (candidate.buyerRoleIdentified) {
    buyerAccessibility = 5;  // Target role title identified (e.g. Head of Compliance) without named person
  }

  // 6. Regulatory Trigger Events (Max 5)
  let regulatoryTrigger = 0;
  if (candidate.recentRegulatoryEvent) regulatoryTrigger += 3;
  if (candidate.recentLicensingDeadline) regulatoryTrigger += 2;
  regulatoryTrigger = Math.min(5, regulatoryTrigger);

  // 7. AI Extraction / Data Confidence Adjustment (Max 10)
  const conf = Math.max(0, Math.min(1, candidate.confidence ?? 0.8));
  const confidenceAdjustment = Math.round(conf * 10);

  const totalScore = Math.min(
    100,
    regulatoryExposure +
      sheriaBotFit +
      complexity +
      companySize +
      buyerAccessibility +
      regulatoryTrigger +
      confidenceAdjustment
  );

  return {
    regulatoryExposure,
    sheriaBotFit,
    complexity,
    companySize,
    buyerAccessibility,
    regulatoryTrigger,
    confidenceAdjustment,
    totalScore,
  };
}

// ---------------------------------------------------------------------------
// Unified Lead Qualification Engine
// ---------------------------------------------------------------------------

export function qualifyLead(params: {
  candidate: CandidateLeadInput;
  isExistingCustomer?: boolean;
  isDoNotContact?: boolean;
}): QualificationResult {
  const { candidate, isExistingCustomer, isDoNotContact } = params;

  // 1. Evaluate Hard Exclusions
  const exclusion = evaluateHardExclusions({ candidate, isExistingCustomer, isDoNotContact });
  if (exclusion.isExcluded) {
    return {
      isExcluded: true,
      exclusionReason: exclusion.reason,
      score: 0,
      scoreBreakdown: {
        regulatoryExposure: 0,
        sheriaBotFit: 0,
        complexity: 0,
        companySize: 0,
        buyerAccessibility: 0,
        regulatoryTrigger: 0,
        confidenceAdjustment: 0,
        totalScore: 0,
      },
      icpTier: IcpTier.NON_ICP,
      leadStatus: exclusion.targetStatus,
      priority: 'DISQUALIFIED',
      rejectionReason: exclusion.reason,
    };
  }

  // 2. Determine ICP Tier
  const icpTier = determineIcpTier(candidate);

  // 3. Compute Score
  const scoreBreakdown = calculateLeadScore(candidate, icpTier);
  const score = scoreBreakdown.totalScore;

  // 4. Deterministic Score-to-State Mapping (Amendment 12)
  let leadStatus: LeadStatus;
  let priority: 'HOT' | 'STRONG' | 'NURTURE' | 'DISQUALIFIED';
  let reviewReason: string | undefined;
  let rejectionReason: string | undefined;

  if (score >= 80) {
    priority = 'HOT';
    leadStatus = LeadStatus.PENDING_REVIEW;
    reviewReason = `High priority ICP score (${score}/100) - Tier: ${icpTier}`;
  } else if (score >= 65) {
    priority = 'STRONG';
    leadStatus = LeadStatus.PENDING_REVIEW;
    reviewReason = `Strong ICP score (${score}/100) - Tier: ${icpTier}`;
  } else if (score >= 50) {
    priority = 'NURTURE';
    leadStatus = LeadStatus.NURTURE;
    reviewReason = `Moderate ICP score (${score}/100) placed in nurture`;
  } else {
    priority = 'DISQUALIFIED';
    leadStatus = LeadStatus.REJECTED;
    rejectionReason = `Score below 50 threshold (${score}/100)`;
  }

  return {
    isExcluded: false,
    score,
    scoreBreakdown,
    icpTier,
    leadStatus,
    priority,
    reviewReason,
    rejectionReason,
  };
}
