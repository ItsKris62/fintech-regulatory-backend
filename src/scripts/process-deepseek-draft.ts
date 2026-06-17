import fs from 'fs';
process.env.QUIET = 'true';
import path from 'path';
import { prisma } from '../lib/prisma/client';

async function main() {
  const deepseekDataPath = path.resolve(process.cwd(), 'src/data/deepseek-draft.json');
  const deepseekData = JSON.parse(fs.readFileSync(deepseekDataPath, 'utf8'));

  const linkSummaryPath = path.resolve(process.cwd(), 'link-summary.json');
  const linkSummary = JSON.parse(fs.readFileSync(linkSummaryPath, 'utf8'));
  const manualReviewDocs = linkSummary.manualReview || [];

  const approvedSources = await prisma.approvedSource.findMany();

  const mappedData: any[] = [];
  const processedDocIds = new Set<string>();

  let duplicateCount = 0;
  let unmatchedCount = 0;
  let approvedCount = 0;
  let manualReviewCount = 0;
  let rejectedCount = 0;



  for (const draft of deepseekData) {
    const draftTitle = draft.documentTitle;
    
    if (draftTitle.includes('(alternate)') || draftTitle.includes('(additional)') || draftTitle.includes('(third)')) {
      // Remove duplicate rows entirely
      continue;
    }
    
    let dbDoc = manualReviewDocs.find((doc: any) => 
      doc.title === draftTitle || 
      doc.title.includes(draftTitle)
    );

    if (!dbDoc) {
      unmatchedCount++;
      continue;
    }

    if (processedDocIds.has(dbDoc.id)) {
      duplicateCount++;
      continue;
    }

    processedDocIds.add(dbDoc.id);

    const actualDbDoc = await prisma.regulatoryDocument.findUnique({
      where: { id: dbDoc.id }
    });

    if (!actualDbDoc) continue;

    // Match approved source
    let sourceId = null;
    const sourceMatch = approvedSources.find(s => 
      s.authorityName.toLowerCase().includes(draft.approvedSourceName.toLowerCase()) ||
      s.authorityName.toLowerCase().includes(draft.regulatorOrAuthority.toLowerCase()) ||
      (draft.domain && Array.isArray(s.allowedDomains) && s.allowedDomains.includes(draft.domain))
    );
      if (sourceMatch) {
        sourceId = sourceMatch.id;
      } else {
        sourceId = null;
      }

    // Process dates
    let publicationDate = null;
    if (draft.publicationDate && draft.publicationDate.length >= 10 && !draft.publicationDate.includes('Unknown')) {
      try {
         const d = new Date(draft.publicationDate);
         if (!isNaN(d.getTime()) && draft.publicationDate.includes('-')) {
             publicationDate = d.toISOString();
         }
      } catch (e) {}
    }

    let effectiveDate = null;
    if (draft.effectiveDate && draft.effectiveDate.length >= 10 && !draft.effectiveDate.includes('Unknown')) {
      try {
         const d = new Date(draft.effectiveDate);
         if (!isNaN(d.getTime()) && draft.effectiveDate.includes('-')) {
             effectiveDate = d.toISOString();
         }
      } catch (e) {}
    }

    let officialUrl = draft.officialUrl;
    if (officialUrl === 'Not found' || officialUrl === '—') officialUrl = null;

    let reviewStatus = 'NEEDS_MANUAL_REVIEW';

    // Apply known corrections
    if (draftTitle.includes('National Payment Systems Act')) {
      officialUrl = 'https://new.kenyalaw.org/akn/ke/act/2011/39/eng@2023-09-15/source.pdf';
      const klSource = approvedSources.find(s => s.authorityName.includes('Kenya Law'));
      if (klSource) sourceId = klSource.id;
    } else if (draftTitle.includes('Guidelines on Cybersecurity for Payment Service Providers')) {
      officialUrl = 'https://www.centralbank.go.ke/wp-content/uploads/2019/07/GuidelinesonCybersecurityforPSPs.pdf';
    }

    if (
      draft.manualReviewNeeded === 'yes' ||
      !officialUrl ||
      draft.notes?.toLowerCase().includes('inferred url') ||
      draft.notes?.toLowerCase().includes('broad landing page') ||
      draftTitle.includes('ODPC Guidance Note') ||
      draftTitle.includes('Kenya Artificial Intelligence Strategy') ||
      draftTitle.includes('Kenya Cloud Policy') ||
      draft.notes?.toLowerCase().includes('repository')
    ) {
      reviewStatus = 'NEEDS_MANUAL_REVIEW';
    } else if (draft.confidence === 'high' && officialUrl) {
      reviewStatus = 'APPROVED';
    }

    if (reviewStatus === 'APPROVED') {
      approvedCount++;
    } else {
      manualReviewCount++;
    }

    mappedData.push({
      regulatoryDocumentId: actualDbDoc.id,
      currentTitle: actualDbDoc.title,
      normalizedTitle: draft.documentTitle,
      approvedSourceId: sourceId,
      authorityName: draft.regulatorOrAuthority,
      officialUrl,
      publicationDate,
      retrievedAt: reviewStatus === 'APPROVED' ? new Date().toISOString() : null,
      effectiveDate,
      effectiveEndDate: null,
      versionLabel: draft.versionLabel === 'Unknown' || draft.versionLabel === '—' ? null : draft.versionLabel,
      checksumSha256: null,
      status: actualDbDoc.status,
      authorityStatus: draft.status === 'unknown' ? actualDbDoc.authorityStatus : draft.status.toUpperCase(),
      isBinding: draft.isBinding === 'unclear' ? actualDbDoc.isBinding : (draft.isBinding === 'true' || draft.isBinding === true),
      documentType: draft.documentType,
      jurisdiction: draft.country === 'Kenya' ? 'Kenya' : 'International',
      notes: draft.notes || null,
      reviewStatus,
    });
  }

  const outPath = path.resolve(process.cwd(), 'src/data/priority-source-metadata-intake.json');
  fs.writeFileSync(outPath, JSON.stringify(mappedData, null, 2));

  console.log('--- DeepSeek Draft Processing Report ---');
  console.log(`Total Draft Rows: ${deepseekData.length}`);
  console.log(`Mapped Rows: ${mappedData.length}`);
  console.log(`Duplicates Removed: ${duplicateCount}`);
  console.log(`Unmatched Drafts: ${unmatchedCount}`);
  console.log(`APPROVED: ${approvedCount}`);
  console.log(`NEEDS_MANUAL_REVIEW: ${manualReviewCount}`);
  console.log(`REJECTED: ${rejectedCount}`);
  
  // Also list the blocked vs ready count roughly
  console.log(`\nDocuments Ready for Version Linking: ${approvedCount}`);
  console.log(`Documents Still Blocked: ${manualReviewCount}`);

  process.exit(0);
}

main().catch(console.error);
