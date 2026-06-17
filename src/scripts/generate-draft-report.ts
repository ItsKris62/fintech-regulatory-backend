import { prisma } from '../lib/prisma/client';
import fs from 'fs';
import path from 'path';

// Levenshtein distance implementation
function levenshtein(a: string, b: string): number {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) == a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function getSimilarityScore(a: string, b: string): number {
  const distance = levenshtein(a.toLowerCase(), b.toLowerCase());
  const maxLength = Math.max(a.length, b.length);
  return maxLength === 0 ? 1 : 1 - distance / maxLength;
}

const unmatchedTitles = [
  "GDPR Regulation (EU) 2016/679",
  "NIST AI RMF 1.0",
  "NIST CSF 2.0 Implementation Examples",
  "POCAMLA Act",
  "POCAMLA Regulations",
  "Computer Misuse and Cybercrimes Regulations, 2024",
  "CBK Digital Credit Providers Regulations, 2022",
  "National Payment System Act",
  "Guidelines on Cybersecurity for PSPs",
  "Data Protection Registration Regulations, 2021",
  "Framework for CO2 Reduction in ICT Sector, 2025",
  "Network Redundancy, Resilience and Diversity Guidelines",
  "ODPC Guidance Note on MSMEs",
  "ODPC DPIA Guidance Note"
];

const intakeFile = path.resolve(__dirname, '../../src/data/priority-source-metadata-intake.json');

async function main() {
  const intakeData = JSON.parse(fs.readFileSync(intakeFile, 'utf-8'));
  const docs = await prisma.regulatoryDocument.findMany();
  
  let report = "# Phase 4D Draft Source-Discovery Report\n\n";

  // Part 1: Approved rows
  report += "## 1. APPROVED Rows to Update (Dry Run)\n\n";
  const approvedRows = intakeData.filter((r: any) => r.reviewStatus === 'APPROVED');
  for (const row of approvedRows) {
    const dbDoc = docs.find(d => d.id === row.regulatoryDocumentId);
    if (!dbDoc) continue;

    const overwrites = [];
    if (dbDoc.officialUrl && dbDoc.officialUrl !== row.officialUrl) overwrites.push('officialUrl');
    if (dbDoc.publicationDate && new Date(row.publicationDate).getTime() !== dbDoc.publicationDate.getTime()) overwrites.push('publicationDate');
    if (dbDoc.sourceRegistryId && dbDoc.sourceRegistryId !== row.approvedSourceId) overwrites.push('sourceRegistryId');

    report += `### ${dbDoc.title}\n`;
    report += `- **regulatoryDocumentId**: \`${row.regulatoryDocumentId}\`\n`;
    report += `- **current DB title**: ${dbDoc.title}\n`;
    report += `- **approvedSourceId/sourceRegistryId**: ${row.approvedSourceId || 'None'} (Current DB: ${dbDoc.sourceRegistryId || 'None'})\n`;
    report += `- **officialUrl**: ${row.officialUrl || 'None'} (Current DB: ${dbDoc.officialUrl || 'None'})\n`;
    report += `- **publicationDate**: ${row.publicationDate || 'None'} (Current DB: ${dbDoc.publicationDate ? dbDoc.publicationDate.toISOString() : 'None'})\n`;
    report += `- **effectiveDate**: ${row.effectiveDate || 'None'} (Current DB: ${dbDoc.effectiveDate ? dbDoc.effectiveDate.toISOString() : 'None'})\n`;
    report += `- **versionLabel**: ${row.versionLabel || 'None'} (Current DB: ${dbDoc.version || 'None'})\n`;
    report += `- **status**: ${row.status} (Current DB: ${dbDoc.status})\n`;
    report += `- **authorityStatus**: ${row.authorityStatus} (Current DB: ${dbDoc.authorityStatus})\n`;
    report += `- **isBinding**: ${row.isBinding} (Current DB: ${dbDoc.isBinding})\n`;
    report += `- **documentType**: ${row.documentType} (Current DB: ${dbDoc.documentType})\n`;
    report += `- **existing DB checksum used**: ${dbDoc.checksum || 'None'}\n`;
    report += `- **officialUrl exists in DB**: ${dbDoc.officialUrl ? 'Yes' : 'No'}\n`;
    report += `- **Update would overwrite existing metadata**: ${overwrites.length > 0 ? 'Yes (' + overwrites.join(', ') + ')' : 'No'}\n\n`;
  }

  // Part 2: Skipped rows
  report += "## 2. Skipped NEEDS_MANUAL_REVIEW Rows\n\n";
  const manualReviewRows = intakeData.filter((r: any) => r.reviewStatus === 'NEEDS_MANUAL_REVIEW');
  for (const row of manualReviewRows) {
    report += `- **${row.normalizedTitle}**: Skipped because reviewStatus is \`NEEDS_MANUAL_REVIEW\`.\n`;
  }
  report += "\n";

  // Part 3: Fuzzy Match Report for Unmatched
  report += "## 3. Fuzzy Match Report for Unmatched Documents\n\n";
  for (const draftTitle of unmatchedTitles) {
    const scoredDocs = docs.map(d => ({
      doc: d,
      score: getSimilarityScore(draftTitle, d.title)
    })).sort((a, b) => b.score - a.score).slice(0, 5);

    report += `### Draft Title: ${draftTitle}\n`;
    report += `**Closest 5 DB Matches:**\n`;
    
    scoredDocs.forEach((match, index) => {
      report += `${index + 1}. **${match.doc.title}** (Score: ${(match.score * 100).toFixed(1)}%)\n`;
      report += `   - Jurisdiction: ${match.doc.jurisdiction || 'N/A'}\n`;
      report += `   - Category: ${match.doc.category || 'N/A'}\n`;
      report += `   - Document Type: ${match.doc.documentType || 'N/A'}\n`;
    });

    const topScore = scoredDocs[0]?.score || 0;
    let recommendation = "needs manual title review";
    if (topScore > 0.85) {
      recommendation = "match to existing document (Very High Confidence)";
    } else if (topScore > 0.65) {
      recommendation = "needs manual title review (Possible Match)";
    } else {
      recommendation = "likely not ingested";
    }

    report += `\n**Recommendation:** ${recommendation}\n\n`;
  }

  const reportPath = path.resolve(__dirname, '../../phase4d-report.md');
  fs.writeFileSync(reportPath, report);
  console.log(`Report generated at ${reportPath}`);
}

main().catch(console.error).finally(() => process.exit(0));
