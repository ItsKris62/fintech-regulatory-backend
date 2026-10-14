import crypto from 'crypto';
import { normalizeOfficialUrl } from './source-metadata';

export type ApprovedSourceSeed = {
  id: string;
  jurisdiction: string;
  authorityName: string;
  authorityType: string;
  baseUrl: string;
  allowedDomains: string[];
  notes?: string;
};

export const KENYA_PRIORITY_APPROVED_SOURCES: ApprovedSourceSeed[] = [
  {
    id: 'ke-central-bank-of-kenya',
    jurisdiction: 'Kenya',
    authorityName: 'Central Bank of Kenya',
    authorityType: 'REGULATOR',
    baseUrl: 'https://www.centralbank.go.ke',
    allowedDomains: ['centralbank.go.ke', 'www.centralbank.go.ke'],
  },
  {
    id: 'ke-office-data-protection-commissioner',
    jurisdiction: 'Kenya',
    authorityName: 'Office of the Data Protection Commissioner',
    authorityType: 'REGULATOR',
    baseUrl: 'https://www.odpc.go.ke',
    allowedDomains: ['odpc.go.ke', 'www.odpc.go.ke'],
  },
  {
    id: 'ke-financial-reporting-centre',
    jurisdiction: 'Kenya',
    authorityName: 'Financial Reporting Centre',
    authorityType: 'REGULATOR',
    baseUrl: 'https://www.frc.go.ke',
    allowedDomains: ['frc.go.ke', 'www.frc.go.ke'],
  },
  {
    id: 'ke-kenya-law',
    jurisdiction: 'Kenya',
    authorityName: 'Kenya Law / National Council for Law Reporting',
    authorityType: 'OFFICIAL_LEGAL_PUBLISHER',
    baseUrl: 'https://kenyalaw.org',
    allowedDomains: ['kenyalaw.org', 'www.kenyalaw.org', 'new.kenyalaw.org'],
  },
  {
    id: 'ke-communications-authority',
    jurisdiction: 'Kenya',
    authorityName: 'Communications Authority of Kenya',
    authorityType: 'REGULATOR',
    baseUrl: 'https://www.ca.go.ke',
    allowedDomains: ['ca.go.ke', 'www.ca.go.ke', 'repository.ca.go.ke'],
  },
  {
    id: 'ke-capital-markets-authority',
    jurisdiction: 'Kenya',
    authorityName: 'Capital Markets Authority',
    authorityType: 'REGULATOR',
    baseUrl: 'https://www.cma.or.ke',
    allowedDomains: ['cma.or.ke', 'www.cma.or.ke'],
  },
  {
    id: 'nist',
    jurisdiction: 'GLOBAL',
    authorityName: 'National Institute of Standards and Technology',
    authorityType: 'STANDARDS_BODY',
    baseUrl: 'https://www.nist.gov',
    allowedDomains: ['nist.gov', 'www.nist.gov', 'csrc.nist.gov', 'airc.nist.gov'],
    notes: 'Approved standards body for NIST Cybersecurity Framework and AI RMF standards.',
  },
  {
    id: 'ict-ministry-ke',
    jurisdiction: 'KE',
    authorityName: 'Ministry of Information, Communications and The Digital Economy',
    authorityType: 'MINISTRY',
    baseUrl: 'https://www.ict.go.ke',
    allowedDomains: ['ict.go.ke', 'www.ict.go.ke', 'icta.go.ke', 'www.icta.go.ke'],
    notes: 'Approved issuing ministry for Kenya national ICT policies, cloud policies, and national AI strategies.',
  },
];

export const MULTI_COUNTRY_APPROVED_SOURCES: ApprovedSourceSeed[] = [
  ...KENYA_PRIORITY_APPROVED_SOURCES,
  // Nigeria (NG)
  {
    id: 'ng-ndpc',
    jurisdiction: 'Nigeria',
    authorityName: 'Nigeria Data Protection Commission',
    authorityType: 'REGULATOR',
    baseUrl: 'https://ndpc.gov.ng',
    allowedDomains: ['ndpc.gov.ng', 'www.ndpc.gov.ng'],
    notes: 'Designated supervisory authority under the Nigeria Data Protection Act 2023.',
  },
  {
    id: 'ng-cbn',
    jurisdiction: 'Nigeria',
    authorityName: 'Central Bank of Nigeria',
    authorityType: 'REGULATOR',
    baseUrl: 'https://www.cbn.gov.ng',
    allowedDomains: ['cbn.gov.ng', 'www.cbn.gov.ng'],
    notes: 'Apex banking, payment system, and financial sector regulator in Nigeria.',
  },
  // Rwanda (RW)
  {
    id: 'rw-ncsa',
    jurisdiction: 'Rwanda',
    authorityName: 'National Cyber Security Authority',
    authorityType: 'REGULATOR',
    baseUrl: 'https://www.ncsa.gov.rw',
    allowedDomains: ['ncsa.gov.rw', 'www.ncsa.gov.rw'],
    notes: 'National supervisory authority for data protection, privacy, and cybersecurity in Rwanda.',
  },
  {
    id: 'rw-bnr',
    jurisdiction: 'Rwanda',
    authorityName: 'National Bank of Rwanda',
    authorityType: 'REGULATOR',
    baseUrl: 'https://www.bnr.rw',
    allowedDomains: ['bnr.rw', 'www.bnr.rw'],
    notes: 'Central bank regulating payment service providers, banking, and financial sector cybersecurity in Rwanda.',
  },
  {
    id: 'rw-primature',
    jurisdiction: 'Rwanda',
    authorityName: 'Official Gazette / Office of the Prime Minister',
    authorityType: 'OFFICIAL_LEGAL_PUBLISHER',
    baseUrl: 'https://www.primature.gov.rw',
    allowedDomains: ['primature.gov.rw', 'www.primature.gov.rw', 'minijust.gov.rw'],
    notes: 'Official Gazette publisher for enacted laws and statutory instruments in Rwanda.',
  },
  // Malawi (MW)
  {
    id: 'mw-macra',
    jurisdiction: 'Malawi',
    authorityName: 'Malawi Communications Regulatory Authority',
    authorityType: 'REGULATOR',
    baseUrl: 'https://www.macra.mw',
    allowedDomains: ['macra.mw', 'www.macra.mw'],
    notes: 'Communications and electronic transactions regulator in Malawi.',
  },
  {
    id: 'mw-rbm',
    jurisdiction: 'Malawi',
    authorityName: 'Reserve Bank of Malawi',
    authorityType: 'REGULATOR',
    baseUrl: 'https://www.rbm.mw',
    allowedDomains: ['rbm.mw', 'www.rbm.mw'],
    notes: 'Central bank and payment systems regulator in Malawi.',
  },
  {
    id: 'mw-ministry-information',
    jurisdiction: 'Malawi',
    authorityName: 'Ministry of Information and Digitization',
    authorityType: 'MINISTRY',
    baseUrl: 'https://www.information.gov.mw',
    allowedDomains: ['information.gov.mw', 'www.information.gov.mw'],
    notes: 'Parent ministry for ICT, data protection, and digital economy governance in Malawi.',
  },
];

export const PRIORITY_SOURCE_KEYWORDS = [
  'data protection',
  'privacy',
  'personal data',
  'cyber security',
  'cybersecurity',
  'electronic transactions',
  'odpc',
  'national payment',
  'payment system',
  'digital credit',
  'pocamla',
  'proceeds of crime',
  'anti-money laundering',
  'aml',
  'financial reporting centre',
  'risk management',
  'banking act',
  'prudential guideline',
  'nist',
  'cloud policy',
  'artificial intelligence',
  'ai strategy',
  'ict policy',
  'ndpc',
  'cbn',
  'ncsa',
  'bnr',
  'macra',
  'rbm',
];

export function isPriorityRegulatoryDocument(doc: {
  title?: string | null;
  category?: string | null;
  source?: string | null;
  documentType?: string | null;
}): boolean {
  const haystack = [doc.title, doc.category, doc.source, doc.documentType].filter(Boolean).join(' ').toLowerCase();
  return PRIORITY_SOURCE_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

export function matchApprovedSourceId(doc: { source?: string | null; title?: string | null; category?: string | null; officialUrl?: string | null }): string | null {
  if (doc.officialUrl) {
    const url = normalizeOfficialUrl(doc.officialUrl);
    if (url) {
      try {
        const hostname = new URL(url).hostname.toLowerCase();
        for (const source of MULTI_COUNTRY_APPROVED_SOURCES) {
          if (source.allowedDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))) {
            return source.id;
          }
        }
      } catch (e) {
        // ignore url parsing error
      }
    }
  }

  const haystack = [doc.source, doc.title, doc.category].filter(Boolean).join(' ').toLowerCase();

  // Multi-Country Authorities
  // Nigeria
  if (/\bndpc\b|nigeria data protection|data protection commission/i.test(haystack)) return 'ng-ndpc';
  if (/central bank of nigeria|\bcbn\b|bofia|banks and other financial institutions/i.test(haystack)) return 'ng-cbn';

  // Rwanda
  if (/\bncsa\b|national cyber security authority|protection of personal data and privacy/i.test(haystack)) return 'rw-ncsa';
  if (/national bank of rwanda|\bbnr\b|payment services providers|cyber security in regulated/i.test(haystack)) return 'rw-bnr';
  if (/official gazette|primature|republic of rwanda/i.test(haystack)) return 'rw-primature';

  // Malawi
  if (/\bmacra\b|malawi communications|electronic transactions and cyber/i.test(haystack)) return 'mw-macra';
  if (/reserve bank of malawi|\brbm\b|payment systems act/i.test(haystack)) return 'mw-rbm';
  if (/ministry of information|malawi government/i.test(haystack)) return 'mw-ministry-information';

  // Kenya & Global
  if (/\bnist\b|national institute of standards/i.test(haystack)) return 'nist';
  if (/ministry of ict|ict ministry|ict authority|information, communications and the digital economy|government of kenya|ict policy|cloud policy|artificial intelligence strategy|ai strategy/i.test(haystack)) return 'ict-ministry-ke';
  if (/\bodpc\b|data protection commissioner/i.test(haystack)) return 'ke-office-data-protection-commissioner';
  if (/communications authority|\bca\b/i.test(haystack)) return 'ke-communications-authority';
  if (/central bank|cbk|payment system|digital credit|prudential|banking act/i.test(haystack)) return 'ke-central-bank-of-kenya';
  if (/financial reporting centre|\bfrc\b|pocamla|aml|anti-money laundering|proceeds of crime/i.test(haystack)) return 'ke-financial-reporting-centre';
  if (/capital markets|cma/i.test(haystack)) return 'ke-capital-markets-authority';
  if (/kenya law|national council for law reporting|act|regulation/i.test(haystack)) return 'ke-kenya-law';
  return null;
}

export function buildSourceDocumentVersionId(input: {
  regulatoryDocumentId: string;
  officialUrl: string;
  checksumSha256?: string | null;
  versionLabel?: string | null;
}): string {
  const normalizedUrl = normalizeOfficialUrl(input.officialUrl) ?? input.officialUrl.trim();
  const digest = crypto.createHash('sha256').update(JSON.stringify({
    regulatoryDocumentId: input.regulatoryDocumentId,
    officialUrl: normalizedUrl,
    checksumSha256: input.checksumSha256 ?? null,
    versionLabel: input.versionLabel ?? null,
  })).digest('hex').slice(0, 20);
  return `sdv_${input.regulatoryDocumentId}_${digest}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}
