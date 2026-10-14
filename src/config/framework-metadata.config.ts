import { type JurisdictionCode } from '@/types/jurisdiction';

export type FrameworkScope = 'DOMESTIC' | 'INTERNATIONAL' | 'CROSS_BORDER';

export interface RegulatoryFrameworkMetadata {
  slug: string;
  name: string;
  category: string;
  tier: 'STARTUP' | 'BUSINESS' | 'ENTERPRISE';
  scope: FrameworkScope;
  jurisdictions: JurisdictionCode[];
  regulator?: string;
  description?: string;
}

/**
 * Authoritative metadata registry for regulatory frameworks supported by SheriaBot.
 * 
 * Rules:
 * - DOMESTIC frameworks apply only to explicit jurisdictions (e.g. Kenya domestic laws apply to KE).
 * - INTERNATIONAL frameworks (e.g. ISO 27001, PCI-DSS, FATF, SOC 2, SWIFT CSP, Basel III, GDPR)
 *   are applicable across all jurisdictions and retrieve international standards corpus.
 * - CROSS_BORDER frameworks apply to designated multi-jurisdiction regions.
 */
export const FRAMEWORK_METADATA_REGISTRY: Record<string, RegulatoryFrameworkMetadata> = {
  // ─── STARTUP Tier (Kenya Domestic) ─────────────────────────────────────────
  'dpa-2019': {
    slug: 'dpa-2019',
    name: 'Data Protection Act 2019',
    category: 'Data Protection',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'ODPC',
  },
  'odpc-regs-2021': {
    slug: 'odpc-regs-2021',
    name: 'ODPC Data Protection Regulations 2021',
    category: 'Data Protection',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'ODPC',
  },
  'cbk-prudential': {
    slug: 'cbk-prudential',
    name: 'CBK Prudential Guidelines',
    category: 'Banking Supervision',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },
  'nps-2011': {
    slug: 'nps-2011',
    name: 'National Payment System Act 2011',
    category: 'Payments',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },
  'nps-regs-2014': {
    slug: 'nps-regs-2014',
    name: 'National Payment System Regulations 2014',
    category: 'Payments',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },
  'pocamla': {
    slug: 'pocamla',
    name: 'Proceeds of Crime and Anti-Money Laundering Act',
    category: 'AML/CFT',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'FRC',
  },
  'pocamla-regs-2013': {
    slug: 'pocamla-regs-2013',
    name: 'POCAMLA Regulations 2013',
    category: 'AML/CFT',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'FRC',
  },
  'cbk-kyc': {
    slug: 'cbk-kyc',
    name: 'CBK Know Your Customer Requirements',
    category: 'AML/CFT',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },
  'cbk-cyber': {
    slug: 'cbk-cyber',
    name: 'CBK Cybersecurity Guidance Note',
    category: 'Cybersecurity',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },
  'computer-misuse-2018': {
    slug: 'computer-misuse-2018',
    name: 'Computer Misuse and Cybercrimes Act 2018',
    category: 'Cybersecurity',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'NC4',
  },
  'companies-act-2015': {
    slug: 'companies-act-2015',
    name: 'Companies Act 2015',
    category: 'Corporate Governance',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'BRS',
  },
  'frc-guidelines': {
    slug: 'frc-guidelines',
    name: 'Financial Reporting Centre AML Guidelines',
    category: 'AML/CFT',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'FRC',
  },
  'consumer-protection-act-2012': {
    slug: 'consumer-protection-act-2012',
    name: 'Consumer Protection Act 2012',
    category: 'Consumer Protection',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CAK',
  },

  // ─── BUSINESS Tier (Kenya Domestic) ───────────────────────────────────────
  'dcpr-2022': {
    slug: 'dcpr-2022',
    name: 'Digital Credit Providers Regulations 2022',
    category: 'Digital Credit',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },
  'consumer-protection': {
    slug: 'consumer-protection',
    name: 'CBK Consumer Protection Guidelines',
    category: 'Consumer Protection',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },
  'mobile-money-guidelines': {
    slug: 'mobile-money-guidelines',
    name: 'CBK Mobile Money Transfer Services Guidelines',
    category: 'Mobile Money',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },
  'agent-banking-guidelines': {
    slug: 'agent-banking-guidelines',
    name: 'CBK Agent Banking Guidelines',
    category: 'Payments',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },
  'credit-reference-regs-2013': {
    slug: 'credit-reference-regs-2013',
    name: 'Credit Reference Bureau Regulations 2013',
    category: 'Credit & Lending',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },
  'cma-act': {
    slug: 'cma-act',
    name: 'Capital Markets Authority Act',
    category: 'Capital Markets',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CMA',
  },
  'cma-cis-regs': {
    slug: 'cma-cis-regs',
    name: 'CMA Collective Investment Schemes Regulations 2001',
    category: 'Capital Markets',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CMA',
  },
  'insurance-act': {
    slug: 'insurance-act',
    name: 'Insurance Act Cap 487',
    category: 'Insurance',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'IRA',
  },
  'ira-digital-guidelines': {
    slug: 'ira-digital-guidelines',
    name: 'IRA Digital Insurance Guidelines',
    category: 'Insurance',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'IRA',
  },
  'kica': {
    slug: 'kica',
    name: 'Kenya Information and Communications Act',
    category: 'Telecommunications',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CA',
  },
  'microfinance-2006': {
    slug: 'microfinance-2006',
    name: 'Microfinance Act 2006',
    category: 'Microfinance & SACCO',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },
  'sacco-act-2008': {
    slug: 'sacco-act-2008',
    name: 'SACCO Societies Act 2008',
    category: 'Microfinance & SACCO',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'SASRA',
  },
  'movable-property-2017': {
    slug: 'movable-property-2017',
    name: 'Movable Property Security Rights Act 2017',
    category: 'Credit & Lending',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'BRS',
  },
  'competition-act-2010': {
    slug: 'competition-act-2010',
    name: 'Competition Act 2010',
    category: 'Corporate Governance',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CAK',
  },
  'tax-procedures-2015': {
    slug: 'tax-procedures-2015',
    name: 'Tax Procedures Act 2015',
    category: 'Tax & Compliance',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'KRA',
  },
  'cbk-fraud-risk': {
    slug: 'cbk-fraud-risk',
    name: 'CBK Fraud Risk Management Guidelines',
    category: 'Operational Risk',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },
  'cbk-bancassurance': {
    slug: 'cbk-bancassurance',
    name: 'CBK Bancassurance Guidelines',
    category: 'Insurance',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },

  // ─── ENTERPRISE Tier (Kenya Domestic + International) ──────────────────────
  'cbk-capital-adequacy': {
    slug: 'cbk-capital-adequacy',
    name: 'CBK Capital Adequacy Guidelines',
    category: 'Banking Supervision',
    tier: 'ENTERPRISE',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },
  'cbk-liquidity-risk': {
    slug: 'cbk-liquidity-risk',
    name: 'CBK Liquidity Risk Management Guidelines',
    category: 'Banking Supervision',
    tier: 'ENTERPRISE',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },
  'cbk-operational-risk': {
    slug: 'cbk-operational-risk',
    name: 'CBK Operational Risk Management Guidelines',
    category: 'Operational Risk',
    tier: 'ENTERPRISE',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },
  'cbk-outsourcing': {
    slug: 'cbk-outsourcing',
    name: 'CBK Outsourcing Guidelines',
    category: 'Operational Risk',
    tier: 'ENTERPRISE',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },
  'cbk-stress-testing': {
    slug: 'cbk-stress-testing',
    name: 'CBK Stress Testing Guidelines',
    category: 'Banking Supervision',
    tier: 'ENTERPRISE',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CBK',
  },
  'cma-sandbox': {
    slug: 'cma-sandbox',
    name: 'CMA Regulatory Sandbox Framework',
    category: 'Innovation & Digital Assets',
    tier: 'ENTERPRISE',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CMA',
  },
  'cma-digital-assets': {
    slug: 'cma-digital-assets',
    name: 'CMA Digital Assets Guidelines',
    category: 'Innovation & Digital Assets',
    tier: 'ENTERPRISE',
    scope: 'DOMESTIC',
    jurisdictions: ['KE'],
    regulator: 'CMA',
  },

  // ─── NIGERIA Domestic Frameworks ──────────────────────────────────────────
  'ndpa-2023': {
    slug: 'ndpa-2023',
    name: 'Nigeria Data Protection Act 2023',
    category: 'Data Protection',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['NG'],
    regulator: 'NDPC',
  },
  'cbn-cybersecurity-2024': {
    slug: 'cbn-cybersecurity-2024',
    name: 'CBN Risk-Based Cybersecurity Framework 2024',
    category: 'Cybersecurity',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['NG'],
    regulator: 'CBN',
  },
  'bofia-2020': {
    slug: 'bofia-2020',
    name: 'Banks and Other Financial Institutions Act 2020',
    category: 'Banking Supervision',
    tier: 'BUSINESS',
    scope: 'DOMESTIC',
    jurisdictions: ['NG'],
    regulator: 'CBN',
  },

  // ─── RWANDA Domestic Frameworks ───────────────────────────────────────────
  'rw-dpa-2021': {
    slug: 'rw-dpa-2021',
    name: 'Law Relating to the Protection of Personal Data and Privacy 2021',
    category: 'Data Protection',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['RW'],
    regulator: 'NCSA',
  },
  'bnr-cybersecurity-2021': {
    slug: 'bnr-cybersecurity-2021',
    name: 'BNR Regulation on Cyber Security in Regulated Institutions',
    category: 'Cybersecurity',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['RW'],
    regulator: 'BNR',
  },
  'bnr-psp-2018': {
    slug: 'bnr-psp-2018',
    name: 'BNR Regulation Governing Payment Services Providers',
    category: 'Payments',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['RW'],
    regulator: 'BNR',
  },

  // ─── MALAWI Domestic Frameworks ───────────────────────────────────────────
  'mw-cybersecurity-2016': {
    slug: 'mw-cybersecurity-2016',
    name: 'Electronic Transactions and Cyber Security Act 2016',
    category: 'Cybersecurity',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['MW'],
    regulator: 'MACRA',
  },
  'mw-dpa-2024': {
    slug: 'mw-dpa-2024',
    name: 'Data Protection Act 2024',
    category: 'Data Protection',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['MW'],
    regulator: 'MACRA',
  },
  'rbm-payment-systems-2016': {
    slug: 'rbm-payment-systems-2016',
    name: 'Payment Systems Act 2016',
    category: 'Payments',
    tier: 'STARTUP',
    scope: 'DOMESTIC',
    jurisdictions: ['MW'],
    regulator: 'RBM',
  },

  // ─── INTERNATIONAL Standards ──────────────────────────────────────────────
  'fatf-recommendations': {
    slug: 'fatf-recommendations',
    name: 'FATF 40 Recommendations',
    category: 'AML/CFT',
    tier: 'ENTERPRISE',
    scope: 'INTERNATIONAL',
    jurisdictions: [],
    regulator: 'FATF',
  },
  'basel-iii': {
    slug: 'basel-iii',
    name: 'Basel III Capital and Liquidity Framework',
    category: 'Banking Supervision',
    tier: 'ENTERPRISE',
    scope: 'INTERNATIONAL',
    jurisdictions: [],
    regulator: 'BCBS',
  },
  'iso-27001': {
    slug: 'iso-27001',
    name: 'ISO/IEC 27001 — Information Security Management',
    category: 'International Standards',
    tier: 'ENTERPRISE',
    scope: 'INTERNATIONAL',
    jurisdictions: [],
    regulator: 'ISO/IEC',
  },
  'pci-dss': {
    slug: 'pci-dss',
    name: 'PCI-DSS — Payment Card Industry Data Security Standard',
    category: 'International Standards',
    tier: 'ENTERPRISE',
    scope: 'INTERNATIONAL',
    jurisdictions: [],
    regulator: 'PCI SSC',
  },
  'gdpr': {
    slug: 'gdpr',
    name: 'EU General Data Protection Regulation',
    category: 'Data Protection',
    tier: 'ENTERPRISE',
    scope: 'INTERNATIONAL',
    jurisdictions: [],
    regulator: 'EDPB',
  },
  'swift-csp': {
    slug: 'swift-csp',
    name: 'SWIFT Customer Security Programme',
    category: 'International Standards',
    tier: 'ENTERPRISE',
    scope: 'INTERNATIONAL',
    jurisdictions: [],
    regulator: 'SWIFT',
  },
  'soc2-type-ii': {
    slug: 'soc2-type-ii',
    name: 'SOC 2 Type II — Service Organization Controls',
    category: 'International Standards',
    tier: 'ENTERPRISE',
    scope: 'INTERNATIONAL',
    jurisdictions: [],
    regulator: 'AICPA',
  },
};

/**
 * Returns framework metadata for a given slug, or a synthetic default if unlisted.
 */
export function getFrameworkMetadata(slug: string): RegulatoryFrameworkMetadata | null {
  return FRAMEWORK_METADATA_REGISTRY[slug] ?? null;
}

/**
 * Determines whether a given regulatory framework is applicable to a specific jurisdiction.
 * 
 * - INTERNATIONAL frameworks: universally applicable across all supported jurisdictions.
 * - DOMESTIC frameworks: applicable ONLY if the jurisdiction is in the framework's explicit list.
 * - CROSS_BORDER frameworks: applicable if the jurisdiction is in the cross-border jurisdiction set.
 */
export function isFrameworkApplicableToJurisdiction(
  slugOrMeta: string | RegulatoryFrameworkMetadata,
  jurisdiction: JurisdictionCode,
): boolean {
  const meta = typeof slugOrMeta === 'string' ? getFrameworkMetadata(slugOrMeta) : slugOrMeta;
  if (!meta) {
    // If unknown framework slug, treat as Kenya domestic default for safety, but disallow foreign countries.
    return jurisdiction === 'KE';
  }

  if (meta.scope === 'INTERNATIONAL') {
    return true;
  }

  return meta.jurisdictions.includes(jurisdiction);
}

/**
 * Validates a list of framework slugs against a requested analysis jurisdiction.
 */
export function validateFrameworkApplicability(
  frameworkSlugs: string[],
  jurisdiction: JurisdictionCode,
): { valid: boolean; incompatibleSlugs: string[] } {
  const incompatibleSlugs = frameworkSlugs.filter(
    (slug) => !isFrameworkApplicableToJurisdiction(slug, jurisdiction),
  );
  return {
    valid: incompatibleSlugs.length === 0,
    incompatibleSlugs,
  };
}
