import { ComplianceCategory } from '@prisma/client';

export interface BaselineRequirementDefinition {
  requirementKey: string;
  jurisdictionCode: string;
  category: ComplianceCategory;
  title: string;
  description: string;
}

export const KENYA_BASELINE_REQUIREMENTS: readonly BaselineRequirementDefinition[] = [
  // Data Protection - Kenya Data Protection Act 2019
  {
    requirementKey: 'KE:DATA_PROTECTION:DPO_REGISTRATION',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.DATA_PROTECTION,
    title: 'Data Protection Officer (DPO) registered',
    description: 'A Data Protection Officer has been appointed and registered with the Office of the Data Protection Commissioner.',
  },
  {
    requirementKey: 'KE:DATA_PROTECTION:PRIVACY_POLICY',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.DATA_PROTECTION,
    title: 'Privacy policy published',
    description: 'A comprehensive privacy policy is publicly available on the company website or accessible to customers.',
  },
  {
    requirementKey: 'KE:DATA_PROTECTION:DPA_VENDOR_AGREEMENTS',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.DATA_PROTECTION,
    title: 'Data processing agreements in place',
    description: 'Written data processing agreements exist with all third-party vendors and processors handling personal data.',
  },
  {
    requirementKey: 'KE:DATA_PROTECTION:CONSENT_MANAGEMENT',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.DATA_PROTECTION,
    title: 'Consent management procedures documented',
    description: 'Procedures for obtaining, recording, and withdrawing data subject consent are formally documented and implemented.',
  },
  {
    requirementKey: 'KE:DATA_PROTECTION:DATA_BREACH_NOTIFICATION',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.DATA_PROTECTION,
    title: 'Data breach notification procedure documented',
    description: 'A documented procedure exists for detecting, reporting, and notifying data breaches within 72 hours.',
  },
  {
    requirementKey: 'KE:DATA_PROTECTION:CROSS_BORDER_SAFEGUARDS',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.DATA_PROTECTION,
    title: 'Cross-border data transfer safeguards',
    description: 'Adequate safeguards are in place for any transfer of personal data outside Kenya.',
  },
  {
    requirementKey: 'KE:DATA_PROTECTION:DPIA_COMPLETED',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.DATA_PROTECTION,
    title: 'Data Protection Impact Assessments (DPIA) completed',
    description: 'DPIAs have been conducted for all high-risk data processing activities.',
  },

  // AML/KYC - Proceeds of Crime and Anti-Money Laundering Act
  {
    requirementKey: 'KE:AML_KYC:KYC_PROCEDURES',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.AML_KYC,
    title: 'KYC procedures documented and implemented',
    description: 'Formal Know Your Customer procedures are documented, approved, and actively implemented across all onboarding flows.',
  },
  {
    requirementKey: 'KE:AML_KYC:CUSTOMER_DUE_DILIGENCE',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.AML_KYC,
    title: 'Customer Due Diligence (CDD) process in place',
    description: 'A structured Customer Due Diligence process is operational for all new and existing customers.',
  },
  {
    requirementKey: 'KE:AML_KYC:ENHANCED_DUE_DILIGENCE',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.AML_KYC,
    title: 'Enhanced Due Diligence for high-risk customers',
    description: 'Enhanced Due Diligence procedures are applied to politically exposed persons (PEPs) and other high-risk customers.',
  },
  {
    requirementKey: 'KE:AML_KYC:SUSPICIOUS_TRANSACTION_REPORTING',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.AML_KYC,
    title: 'Suspicious Transaction Reporting (STR) procedures',
    description: 'Formal procedures exist for identifying, reviewing, and reporting suspicious transactions to the Financial Reporting Centre (FRC).',
  },
  {
    requirementKey: 'KE:AML_KYC:AML_COMPLIANCE_OFFICER',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.AML_KYC,
    title: 'AML compliance officer appointed',
    description: 'A dedicated AML Compliance Officer has been appointed and is registered with the relevant regulatory authority.',
  },
  {
    requirementKey: 'KE:AML_KYC:STAFF_AML_TRAINING',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.AML_KYC,
    title: 'Staff AML training completed',
    description: 'All relevant staff have completed AML/CFT awareness and compliance training within the past 12 months.',
  },
  {
    requirementKey: 'KE:AML_KYC:TRANSACTION_MONITORING',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.AML_KYC,
    title: 'Transaction monitoring system in place',
    description: 'An automated or manual transaction monitoring system is operational to detect unusual or suspicious activity.',
  },
  {
    requirementKey: 'KE:AML_KYC:RECORD_KEEPING_POLICY',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.AML_KYC,
    title: 'Record-keeping policy (7-year minimum)',
    description: 'A record-keeping policy compliant with the 7-year minimum retention requirement under Kenyan AML law is implemented.',
  },

  // Consumer Protection - CBK Consumer Protection Guidelines
  {
    requirementKey: 'KE:CONSUMER_PROTECTION:TRANSPARENT_PRICING',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CONSUMER_PROTECTION,
    title: 'Transparent pricing and fee disclosure',
    description: 'All fees, charges, interest rates, and penalties are clearly disclosed to customers before and during service use.',
  },
  {
    requirementKey: 'KE:CONSUMER_PROTECTION:COMPLAINTS_HANDLING',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CONSUMER_PROTECTION,
    title: 'Complaints handling mechanism in place',
    description: 'A formal complaints handling mechanism with defined escalation paths and response SLAs is operational.',
  },
  {
    requirementKey: 'KE:CONSUMER_PROTECTION:FAIR_DEBT_COLLECTION',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CONSUMER_PROTECTION,
    title: 'Fair debt collection practices documented',
    description: 'Debt collection policies comply with CBK guidelines prohibiting abusive, unfair, or deceptive practices.',
  },
  {
    requirementKey: 'KE:CONSUMER_PROTECTION:PRODUCT_TERMS_DISCLOSURE',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CONSUMER_PROTECTION,
    title: 'Product terms clearly communicated',
    description: 'All product terms and conditions are written in plain language and communicated clearly to customers before sign-up.',
  },
  {
    requirementKey: 'KE:CONSUMER_PROTECTION:PURPOSE_LIMITATION',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CONSUMER_PROTECTION,
    title: 'Customer data used only for stated purposes',
    description: 'A policy exists ensuring customer data is not used for any purpose beyond what was disclosed at the time of collection.',
  },
  {
    requirementKey: 'KE:CONSUMER_PROTECTION:CUSTOMER_SUPPORT_CHANNELS',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CONSUMER_PROTECTION,
    title: 'Accessible customer support channels',
    description: 'Multiple accessible customer support channels (phone, email, chat) are available with published operating hours.',
  },

  // CBK Licensing - CBK Act / National Payment System Act
  {
    requirementKey: 'KE:CBK_LICENSING:PRIMARY_LICENSE',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CBK_LICENSING,
    title: 'Primary CBK license obtained',
    description: 'The organization holds the appropriate CBK license (Payment Service Provider, Mobile Money, Digital Credit Provider, etc.).',
  },
  {
    requirementKey: 'KE:CBK_LICENSING:LICENSE_CURRENT',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CBK_LICENSING,
    title: 'License is current and not expired',
    description: 'The CBK license has been renewed and is valid with no lapsed expiry date.',
  },
  {
    requirementKey: 'KE:CBK_LICENSING:ANNUAL_RETURNS',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CBK_LICENSING,
    title: 'Annual returns filed with CBK',
    description: 'Annual regulatory returns have been submitted to the CBK within the required deadlines.',
  },
  {
    requirementKey: 'KE:CBK_LICENSING:CAPITAL_ADEQUACY',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CBK_LICENSING,
    title: 'Capital adequacy requirements met',
    description: 'The organization meets minimum capital requirements as stipulated by the CBK for its license category.',
  },
  {
    requirementKey: 'KE:CBK_LICENSING:REGULATORY_REPORTS',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CBK_LICENSING,
    title: 'Regulatory reports submitted on time',
    description: 'All required periodic reports (monthly, quarterly) have been submitted to the CBK on schedule.',
  },
  {
    requirementKey: 'KE:CBK_LICENSING:AUTHORIZED_SIGNATORIES',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CBK_LICENSING,
    title: 'Authorized signatories registered with CBK',
    description: 'All authorized signatories and key management personnel are registered with the CBK as required.',
  },

  // Cybersecurity - CBK Cybersecurity Guidelines + Computer Misuse and Cybercrimes Act
  {
    requirementKey: 'KE:CYBERSECURITY:INFOSEC_POLICY',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CYBERSECURITY,
    title: 'Information security policy documented',
    description: 'A comprehensive information security policy has been formally documented, approved by management, and communicated to all staff.',
  },
  {
    requirementKey: 'KE:CYBERSECURITY:INCIDENT_RESPONSE_PLAN',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CYBERSECURITY,
    title: 'Incident response plan in place',
    description: 'A formal cybersecurity incident response plan exists with defined roles, escalation paths, and communication procedures.',
  },
  {
    requirementKey: 'KE:CYBERSECURITY:PENETRATION_TESTING',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CYBERSECURITY,
    title: 'Regular penetration testing conducted',
    description: 'Penetration testing or vulnerability assessments are conducted at least annually by qualified internal or external parties.',
  },
  {
    requirementKey: 'KE:CYBERSECURITY:DATA_ENCRYPTION',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CYBERSECURITY,
    title: 'Data encryption at rest and in transit',
    description: 'All sensitive customer and business data is encrypted at rest (AES-256 or equivalent) and in transit (TLS 1.2+).',
  },
  {
    requirementKey: 'KE:CYBERSECURITY:ACCESS_CONTROL_MFA',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CYBERSECURITY,
    title: 'Access control policies implemented',
    description: 'Role-based access controls, principle of least privilege, and multi-factor authentication are enforced across systems.',
  },
  {
    requirementKey: 'KE:CYBERSECURITY:BCP_DISASTER_RECOVERY',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CYBERSECURITY,
    title: 'Business continuity and disaster recovery plan',
    description: 'A documented and tested business continuity / disaster recovery plan exists with defined RTO and RPO targets.',
  },
  {
    requirementKey: 'KE:CYBERSECURITY:SECURITY_RISK_ASSESSMENT',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CYBERSECURITY,
    title: 'Cybersecurity risk assessment completed',
    description: 'A formal cybersecurity risk assessment has been conducted and documented within the past 12 months.',
  },
  {
    requirementKey: 'KE:CYBERSECURITY:EMPLOYEE_AWARENESS_TRAINING',
    jurisdictionCode: 'KE',
    category: ComplianceCategory.CYBERSECURITY,
    title: 'Employee cybersecurity awareness training',
    description: 'All employees have completed cybersecurity awareness training within the past 12 months.',
  },
];

export const CATEGORY_WEIGHTS: Record<ComplianceCategory, number> = {
  DATA_PROTECTION: 0.25,
  AML_KYC: 0.25,
  CONSUMER_PROTECTION: 0.20,
  CBK_LICENSING: 0.15,
  CYBERSECURITY: 0.15,
};

export const CATEGORY_LABELS: Record<ComplianceCategory, string> = {
  DATA_PROTECTION: 'Data Protection',
  AML_KYC: 'AML / KYC',
  CONSUMER_PROTECTION: 'Consumer Protection',
  CBK_LICENSING: 'CBK Licensing',
  CYBERSECURITY: 'Cybersecurity',
};

export function getBaselineRequirementsForJurisdiction(jurisdictionCode: string): readonly BaselineRequirementDefinition[] {
  if (jurisdictionCode.toUpperCase() === 'KE') {
    return KENYA_BASELINE_REQUIREMENTS;
  }
  // Phase 1: Only Kenya has a verified compliance requirement baseline.
  return [];
}

export function findKenyaBaselineByKey(key: string): BaselineRequirementDefinition | undefined {
  return KENYA_BASELINE_REQUIREMENTS.find((item) => item.requirementKey === key);
}

export function findKenyaBaselineByTitleAndCategory(title: string, category: ComplianceCategory): BaselineRequirementDefinition | undefined {
  return KENYA_BASELINE_REQUIREMENTS.find((item) => item.title === title && item.category === category);
}
