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
    allowedDomains: ['kenyalaw.org', 'www.kenyalaw.org'],
  },
  {
    id: 'ke-communications-authority',
    jurisdiction: 'Kenya',
    authorityName: 'Communications Authority of Kenya',
    authorityType: 'REGULATOR',
    baseUrl: 'https://www.ca.go.ke',
    allowedDomains: ['ca.go.ke', 'www.ca.go.ke'],
  },
  {
    id: 'ke-capital-markets-authority',
    jurisdiction: 'Kenya',
    authorityName: 'Capital Markets Authority',
    authorityType: 'REGULATOR',
    baseUrl: 'https://www.cma.or.ke',
    allowedDomains: ['cma.or.ke', 'www.cma.or.ke'],
  },
];

export const PRIORITY_SOURCE_KEYWORDS = [
  'data protection',
  'odpc',
  'national payment',
  'payment system',
  'digital credit',
  'pocamla',
  'proceeds of crime',
  'anti-money laundering',
  'aml',
  'financial reporting centre',
  'cybersecurity',
  'risk management',
  'banking act',
  'prudential guideline',
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
        for (const source of KENYA_PRIORITY_APPROVED_SOURCES) {
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
  if (/\bodpc\b|data protection commissioner/.test(haystack)) return 'ke-office-data-protection-commissioner';
  if (/central bank|cbk|payment system|digital credit|prudential|banking act/.test(haystack)) return 'ke-central-bank-of-kenya';
  if (/financial reporting centre|\bfrc\b|pocamla|aml|anti-money laundering|proceeds of crime/.test(haystack)) return 'ke-financial-reporting-centre';
  if (/kenya law|national council for law reporting|act|regulation/.test(haystack)) return 'ke-kenya-law';
  if (/communications authority|\bca\b/.test(haystack)) return 'ke-communications-authority';
  if (/capital markets|cma/.test(haystack)) return 'ke-capital-markets-authority';
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
