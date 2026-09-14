import { describe, it, expect } from 'vitest';
import {
  qualifyLead,
  calculateLeadScore,
  determineIcpTier,
  evaluateHardExclusions,
  computeEvidenceHash,
  CandidateLeadInput,
} from './lead-qualification.service';
import { IcpTier, LeadStatus, CompanySizeClass } from '@prisma/client';

describe('Lead Qualification Service (P0)', () => {
  describe('computeEvidenceHash', () => {
    it('produces deterministic SHA-256 hashes regardless of casing/spacing', () => {
      const hash1 = computeEvidenceHash({
        companyIdentifier: 'Acme-Corp',
        field: 'LicenceNumber',
        normalizedValue: 'DCP/001',
        sourceUrl: 'https://cbk.go.ke/dcps/',
        sourceRecordId: 'REC-123',
      });

      const hash2 = computeEvidenceHash({
        companyIdentifier: 'acme-corp',
        field: 'licencenumber',
        normalizedValue: 'dcp/001',
        sourceUrl: 'https://cbk.go.ke/dcps/',
        sourceRecordId: 'rec-123',
      });

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('produces distinct hashes for different field values', () => {
      const hash1 = computeEvidenceHash({
        companyIdentifier: 'company-1',
        field: 'licenceStatus',
        normalizedValue: 'ACTIVE',
        sourceUrl: 'https://cbk.go.ke',
      });

      const hash2 = computeEvidenceHash({
        companyIdentifier: 'company-1',
        field: 'licenceStatus',
        normalizedValue: 'REVOKED',
        sourceUrl: 'https://cbk.go.ke',
      });

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('evaluateHardExclusions', () => {
    it('handles existing paying customers as commercial matches (CONVERTED), not bad leads', () => {
      const candidate: CandidateLeadInput = {
        name: 'Existing Fintech Client',
        domain: 'fintechclient.co.ke',
        country: 'Kenya',
      };

      const res = evaluateHardExclusions({
        candidate,
        isExistingCustomer: true,
      });

      expect(res.isExcluded).toBe(true);
      expect(res.reason).toBe('EXISTING_CUSTOMER');
      expect(res.targetStatus).toBe(LeadStatus.CONVERTED);
    });

    it('excludes do-not-contact / blacklisted companies', () => {
      const candidate: CandidateLeadInput = {
        name: 'Blacklisted Corp',
        domain: 'blacklisted.co.ke',
        licenceStatus: 'DO_NOT_CONTACT',
      };

      const res = evaluateHardExclusions({
        candidate,
        isDoNotContact: true,
      });

      expect(res.isExcluded).toBe(true);
      expect(res.reason).toBe('EXCLUDED_DO_NOT_CONTACT');
      expect(res.targetStatus).toBe(LeadStatus.DO_NOT_CONTACT);
    });

    it('rejects unsupported countries outside the strategic priority set', () => {
      const candidate: CandidateLeadInput = {
        name: 'Foreign Corp',
        domain: 'foreign.de',
        country: 'Germany',
      };

      const res = evaluateHardExclusions({ candidate });
      expect(res.isExcluded).toBe(true);
      expect(res.reason).toBe('REJECTED_UNSUPPORTED_COUNTRY');
      expect(res.targetStatus).toBe(LeadStatus.REJECTED);
    });

    it('rejects revoked or banned licences', () => {
      const candidate: CandidateLeadInput = {
        name: 'Revoked Lender Ltd',
        domain: 'revokedlender.co.ke',
        country: 'Kenya',
        licenceStatus: 'REVOKED',
      };

      const res = evaluateHardExclusions({ candidate });
      expect(res.isExcluded).toBe(true);
      expect(res.reason).toBe('REJECTED_BANNED_REVOKED');
      expect(res.targetStatus).toBe(LeadStatus.REJECTED);
    });
  });

  describe('determineIcpTier', () => {
    it('classifies CBK Digital Credit Providers as Tier 1 Core Fintech', () => {
      const candidate: CandidateLeadInput = {
        name: 'QuickCredit Kenya Ltd',
        regulatoryBody: 'CBK',
        licenceType: 'Digital Credit Provider',
        industry: 'Digital Lending',
      };

      expect(determineIcpTier(candidate)).toBe(IcpTier.TIER_1_CORE_FINTECH);
    });

    it('classifies CMA / SASRA / Insurtech as Tier 2 High Exposure', () => {
      const candidate: CandidateLeadInput = {
        name: 'Apex Wealth Advisors',
        regulatoryBody: 'CMA',
        industry: 'WealthTech',
      };

      expect(determineIcpTier(candidate)).toBe(IcpTier.TIER_2_HIGH_EXPOSURE);
    });

    it('classifies Credit Scoring / KYC vendors as Tier 3 Adjacent', () => {
      const candidate: CandidateLeadInput = {
        name: 'ScoreTech Enablers Ltd',
        industry: 'Credit Scoring',
      };

      expect(determineIcpTier(candidate)).toBe(IcpTier.TIER_3_ADJACENT);
    });

    it('classifies non-regulated general business as NON_ICP', () => {
      const candidate: CandidateLeadInput = {
        name: 'Organic Farm Foods',
        industry: 'Agriculture',
      };

      expect(determineIcpTier(candidate)).toBe(IcpTier.NON_ICP);
    });
  });

  describe('calculateLeadScore & qualifyLead', () => {
    it('qualifies a licensed Tier 1 DCP with named buyer as HOT (80-100) -> PENDING_REVIEW', () => {
      const candidate: CandidateLeadInput = {
        name: 'Tala Kenya Limited',
        domain: 'tala.co.ke',
        country: 'Kenya',
        regulatoryBody: 'CBK',
        licenceType: 'Digital Credit Provider',
        licenceNumber: 'CBK/DCP/005',
        sizeClass: CompanySizeClass.MEDIUM,
        hasComplianceObligation: true,
        handlesPersonalData: true,
        handlesCustomerFunds: true,
        operatesCrossBorder: true,
        hasNamedBuyerContact: true,
        recentRegulatoryEvent: true,
        confidence: 0.95,
      };

      const res = qualifyLead({ candidate });
      expect(res.isExcluded).toBe(false);
      expect(res.icpTier).toBe(IcpTier.TIER_1_CORE_FINTECH);
      expect(res.score).toBeGreaterThanOrEqual(80);
      expect(res.priority).toBe('HOT');
      expect(res.leadStatus).toBe(LeadStatus.PENDING_REVIEW);
      expect(res.scoreBreakdown.regulatoryExposure).toBe(30);
      expect(res.scoreBreakdown.buyerAccessibility).toBe(10);
    });

    it('awards 5 buyer points for role-identified vs 10 for named contact (Amendment 15)', () => {
      const withRole: CandidateLeadInput = {
        name: 'Role Identified Corp',
        domain: 'role.co.ke',
        regulatoryBody: 'CBK',
        licenceType: 'DCP',
        buyerRoleIdentified: true,
        targetRoleTitle: 'Head of Compliance',
        hasNamedBuyerContact: false,
      };

      const withNamed: CandidateLeadInput = {
        ...withRole,
        hasNamedBuyerContact: true,
      };

      const scoreRole = calculateLeadScore(withRole, IcpTier.TIER_1_CORE_FINTECH);
      const scoreNamed = calculateLeadScore(withNamed, IcpTier.TIER_1_CORE_FINTECH);

      expect(scoreRole.buyerAccessibility).toBe(5);
      expect(scoreNamed.buyerAccessibility).toBe(10);
    });

    it('places mid-scoring prospects (50-64) into NURTURE', () => {
      const candidate: CandidateLeadInput = {
        name: 'Small Fintech Startup',
        domain: 'smallfintech.co.ke',
        country: 'Kenya',
        regulatoryBody: 'CBK',
        licenceType: 'Payment Service Provider',
        sizeClass: CompanySizeClass.MICRO,
        hasComplianceObligation: true,
        handlesPersonalData: true,
        confidence: 0.7,
      };

      const res = qualifyLead({ candidate });
      expect(res.score).toBeGreaterThanOrEqual(50);
      expect(res.score).toBeLessThan(65);
      expect(res.priority).toBe('NURTURE');
      expect(res.leadStatus).toBe(LeadStatus.NURTURE);
    });

    it('rejects low-scoring (<50) unqualified leads', () => {
      const candidate: CandidateLeadInput = {
        name: 'Generic Tech Blog',
        domain: 'techblog.co.ke',
        country: 'Kenya',
        industry: 'Publishing',
        confidence: 0.5,
      };

      const res = qualifyLead({ candidate });
      expect(res.score).toBeLessThan(50);
      expect(res.priority).toBe('DISQUALIFIED');
      expect(res.leadStatus).toBe(LeadStatus.REJECTED);
      expect(res.rejectionReason).toContain('Score below 50');
    });
  });
});
