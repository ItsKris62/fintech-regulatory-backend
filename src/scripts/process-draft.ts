import { prisma } from '../lib/prisma/client';
import fs from 'fs';
import path from 'path';

const draftData = [
  // High confidence - Kenya Law 5 remaining
  { title: "Computer Misuse and Cybercrimes (Amendment) Act, 2025", source: "Kenya Law", url: "https://new.kenyalaw.org/akn/ke/act/2025/17/eng@2025-10-21/source.pdf", status: "APPROVED candidate" },
  { title: "Computer Misuse and Cybercrimes Act, 2018", source: "Kenya Law", url: "https://new.kenyalaw.org/akn/ke/act/2018/5/eng@2018-05-18", status: "APPROVED candidate, but mark superseded" },
  { title: "Banking Act (Cap. 488)", source: "Kenya Law", url: "https://new.kenyalaw.org/akn/ke/act/1989/9/eng@2024-12-27", status: "APPROVED candidate" },
  { title: "Kenya Information and Communications Act", dbTitle: "Kenya Information and Communications Act (No. 2 of 1998)", source: "Kenya Law", url: "https://new.kenyalaw.org/akn/ke/act/1998/2/eng@1998-11-09", status: "APPROVED candidate" },
  { title: "Kenya Data Protection Act, 2019", dbTitle: "Kenya Data Protection Act, 2019 (No. 24 of 2019)", source: "Kenya Law", url: "https://new.kenyalaw.org/akn/ke/act/2019/24/eng@2019-11-15", status: "APPROVED candidate" },
  
  // High confidence but missing source info so NEEDS_MANUAL_REVIEW
  { title: "NIST Cybersecurity Framework 2.0", source: "NIST", url: "https://www.nist.gov/cyberframework", status: "NEEDS_MANUAL_REVIEW" },
  
  // Previous APPROVED but fuzzy matches or other sources
  { title: "GDPR Regulation (EU) 2016/679", dbTitle: "General Data Protection Regulation (GDPR) — Regulation (EU) 2016/679", source: "EUR-Lex", url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679", status: "APPROVED candidate" },
  { title: "NIST AI RMF 1.0", dbTitle: "NIST AI Risk Management Framework (AI RMF 1.0)", source: "NIST", url: "https://airc.nist.gov/AI_RMF_Knowledge_Base/AI_RMF", status: "NEEDS_MANUAL_REVIEW" },
  { title: "NIST CSF 2.0 Implementation Examples", dbTitle: "NIST Cybersecurity Framework 2.0 — Implementation Examples", source: "NIST", url: null, status: "NEEDS_MANUAL_REVIEW" },
  { title: "POCAMLA Regulations", dbTitle: "Proceeds of Crime and Anti-Money Laundering (POCAMLA) Regulations", source: "Kenya Law", url: "https://new.kenyalaw.org/akn/ke/act/ln/2023/153/eng@2023-11-17/source.pdf", status: "APPROVED candidate" },
  { title: "Computer Misuse and Cybercrimes Regulations, 2024", source: "Kenya Law", url: "https://new.kenyalaw.org/akn/ke/act/ln/2024/44/eng@2024-02-16", status: "APPROVED candidate" },
  { title: "CBK Digital Credit Providers Regulations, 2022", dbTitle: "Central Bank of Kenya (Digital Credit Providers) Regulations, 2022 (L.N. No. 46)", source: "CBK", url: "https://www.centralbank.go.ke/2022/03/21/central-bank-of-kenya-digital-credit-providers-regulations-2022/", status: "APPROVED candidate" },
  { title: "National Payment System Act", dbTitle: "National Payment Systems Act", source: "Kenya Law", url: "https://new.kenyalaw.org/akn/ke/act/2011/39/eng@2023-09-15", status: "APPROVED candidate" },
  { title: "Guidelines on Cybersecurity for PSPs", dbTitle: "Guidelines on Cybersecurity for Payment Service Providers", source: "CBK", url: "https://www.centralbank.go.ke/wp-content/uploads/2019/07/GuidelinesonCybersecurityforPSPs.pdf", status: "APPROVED candidate" },
  { title: "Data Protection Registration Regulations, 2021", dbTitle: "Data Protection (Registration of Data Controllers and Data Processors) Regulations, 2021", source: "Kenya Law", url: "https://new.kenyalaw.org/akn/ke/act/ln/2021/265/eng@2022-01-14", status: "APPROVED candidate" },
  
  // Previous Manual Review matches
  { title: "Kenya Artificial Intelligence Strategy 2025-2030", status: "NEEDS_MANUAL_REVIEW" },
  { title: "Kenya Cloud Policy, 2024", status: "NEEDS_MANUAL_REVIEW" },
  { title: "National ICT Policy, 2019", status: "NEEDS_MANUAL_REVIEW" },
  { title: "CBK Prudential Guidelines", status: "NEEDS_MANUAL_REVIEW" },
  { title: "Framework for CO2 Reduction in ICT Sector, 2025", dbTitle: "Framework for CO2 Reduction in the ICT Sector, 2025", status: "NEEDS_MANUAL_REVIEW" },
  { title: "Environmental and Social Impact Assessment Guidelines for ICT Projects, 2025", status: "NEEDS_MANUAL_REVIEW" },
  { title: "Guidelines for Undertaking ICT Infrastructure Works", status: "NEEDS_MANUAL_REVIEW" },
  { title: "Network Redundancy, Resilience and Diversity Guidelines", dbTitle: "Guidelines for Network Redundancy, Resilience and Diversity for ICT Networks in Kenya", status: "NEEDS_MANUAL_REVIEW" },
  { title: "ODPC Guidance Note on MSMEs", dbTitle: "ODPC Guidance Note on Data Processing by MSMEs", status: "NEEDS_MANUAL_REVIEW" },
  { title: "ODPC DPIA Guidance Note", dbTitle: "ODPC Guidance Note on Data Protection Impact Assessment (DPIA)", status: "NEEDS_MANUAL_REVIEW" },
  { title: "Data Protection Compliance Audit Regulations, 2024", dbTitle: "Data Protection (Compliance Audit) Regulations, 2024", status: "NEEDS_MANUAL_REVIEW" },
];

function extractVersionDateFromUrl(url: string | undefined): { date: string | null, versionLabel: string | null } {
  if (!url) return { date: null, versionLabel: null };
  const match = url.match(/@(.*?)(?:\/|$)/);
  if (match) {
    return { date: null, versionLabel: `eng@${match[1]}` }; // Store as versionLabel per user
  }
  return { date: null, versionLabel: null };
}

async function main() {
  const intakeList: any[] = [];
  
  const sources = await prisma.approvedSource.findMany();
  const docs = await prisma.regulatoryDocument.findMany();

  for (const item of draftData) {
    // Exact or partial match logic
    const doc = docs.find(d => 
      (item.dbTitle && d.title === item.dbTitle) ||
      (!item.dbTitle && d.title === item.title) ||
      (!item.dbTitle && d.title.toLowerCase().includes(item.title.toLowerCase())) ||
      (!item.dbTitle && item.title.toLowerCase().includes(d.title.toLowerCase())) ||
      (!item.dbTitle && d.title.toLowerCase().replace(/[^a-z0-9]/g, '') === item.title.toLowerCase().replace(/[^a-z0-9]/g, ''))
    );
    
    if (!doc) {
      console.warn(`Could not find document for ${item.title}`);
      continue;
    }

    let sourceId: string | null = null;
    let authorityName = 'Unknown';
    if (item.source) {
      const src = sources.find(s => s.authorityName.toLowerCase() === item.source!.toLowerCase() || s.authorityName.toLowerCase().includes(item.source!.toLowerCase()));
      if (src) {
        sourceId = src.id;
        authorityName = src.authorityName;
      }
    }

    // Determine reviewStatus
    let reviewStatus = item.status === 'NEEDS_MANUAL_REVIEW' ? 'NEEDS_MANUAL_REVIEW' : 'APPROVED';
    // User instruction: "keep them NEEDS_MANUAL_REVIEW unless their URL/source metadata is high-confidence and validator-approved"
    // Since some don't have sourceId, if they lack it, they must be NEEDS_MANUAL_REVIEW
    if (reviewStatus === 'APPROVED' && !sourceId) {
       reviewStatus = 'NEEDS_MANUAL_REVIEW';
    }

    const { date, versionLabel } = extractVersionDateFromUrl(item.url || undefined);
    
    intakeList.push({
      regulatoryDocumentId: doc.id,
      currentTitle: doc.title,
      normalizedTitle: item.title,
      approvedSourceId: sourceId,
      authorityName: authorityName,
      officialUrl: item.url || null,
      publicationDate: date, // Keep publicationDate null if we use it for version
      retrievedAt: null,
      effectiveDate: null,
      effectiveEndDate: null,
      versionLabel: versionLabel,
      checksumSha256: null,
      status: doc.status || 'ACTIVE',
      authorityStatus: doc.authorityStatus || 'IN_FORCE',
      isBinding: doc.isBinding ?? true,
      documentType: doc.documentType || 'LEGISLATION',
      jurisdiction: doc.jurisdiction || 'KE',
      notes: item.status,
      reviewStatus: reviewStatus,
    });
  }

  const outputPath = path.join(__dirname, '../../src/data/priority-source-metadata-intake.json');
  fs.writeFileSync(outputPath, JSON.stringify(intakeList, null, 2));
  console.log(`Wrote ${intakeList.length} items to ${outputPath}`);
}

main().catch(console.error).finally(() => process.exit(0));
