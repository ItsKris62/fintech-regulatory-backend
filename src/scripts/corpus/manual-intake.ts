import * as fs from 'fs';
import * as path from 'path';

// Define expected interface
interface ManualIntakeEntry {
  id: string;
  country: string;
  jurisdictionCode: string;
  title: string;
  sourceUrl: string;
  sourcePageUrl?: string | null;
  regulator: string;
  category: string;
  documentType: string;
  authorityStatus: string;
  isBinding: boolean;
  priority: string;
  tags: string[];
  reviewStatus: string;
  reviewNotes: string;
  proposedLocalPath: string;
  effectiveDate?: string | null;
  publicationDate?: string | null;
  version?: string | null;
}

const args = process.argv.slice(2);
const countryArg = args.find((a) => a.startsWith('--country='));
const forceArg = args.includes('--force');

if (!countryArg) {
  console.error('Usage: pnpm corpus:intake --country=<malawi|nigeria> [--force]');
  process.exit(1);
}

const country = countryArg.split('=')[1].toLowerCase();
const intakePath = path.resolve(`documents/_incoming/${country}/manual-source-intake.json`);
const candidatePath = path.resolve(`documents/_incoming/${country}/candidate-manifest.json`);

if (!fs.existsSync(intakePath)) {
  console.error(`Manual intake not found at ${intakePath}`);
  process.exit(1);
}

let intakeEntries: ManualIntakeEntry[] = [];
try {
  intakeEntries = JSON.parse(fs.readFileSync(intakePath, 'utf-8'));
} catch (error) {
  console.error(`Failed to parse ${intakePath}`, error);
  process.exit(1);
}

let candidateManifest: any = {
  version: 1,
  country: country === 'malawi' ? 'Malawi' : 'Nigeria',
  jurisdictionCode: country === 'malawi' ? 'MW' : 'NG',
  discoveredAt: new Date().toISOString(),
  entries: []
};

if (fs.existsSync(candidatePath)) {
  try {
    candidateManifest = JSON.parse(fs.readFileSync(candidatePath, 'utf-8'));
  } catch (error) {
    console.error(`Failed to parse existing ${candidatePath}`, error);
    // Ignore and recreate if invalid
  }
}

let added = 0;
let updated = 0;
let skipped = 0;

const candidateMap = new Map<string, any>();
(candidateManifest.entries || []).forEach((c: any) => candidateMap.set(c.id, c));

for (const entry of intakeEntries) {
  if (!entry.sourceUrl && !entry.sourcePageUrl) {
    console.warn(`Skipping ${entry.id} - no sourceUrl or sourcePageUrl provided.`);
    continue;
  }

  // Create a candidate entry format from the manual intake format
  const candidateEntry = {
    id: entry.id,
    country: entry.country,
    jurisdictionCode: entry.jurisdictionCode,
    discoveredTitle: entry.title,
    normalizedTitle: entry.title,
    sourceUrl: entry.sourceUrl,
    sourcePageUrl: entry.sourcePageUrl,
    regulator: entry.regulator,
    suggestedCategory: entry.category,
    suggestedDocumentType: entry.documentType,
    suggestedAuthorityStatus: entry.authorityStatus,
    suggestedIsBinding: entry.isBinding,
    priority: entry.priority,
    decision: entry.reviewStatus,
    decisionReason: entry.reviewNotes,
    reviewedBy: "Manual Intake",
    reviewedAt: new Date().toISOString(),
    discoveredAt: new Date().toISOString(),
    proposedLocalPath: entry.proposedLocalPath,
    tags: entry.tags,
  };

  const existing = candidateMap.get(entry.id);
  if (existing) {
    if (!forceArg) {
      // Don't overwrite if not forced
      skipped++;
      continue;
    } else {
      candidateMap.set(entry.id, { ...existing, ...candidateEntry });
      updated++;
    }
  } else {
    candidateMap.set(entry.id, candidateEntry);
    added++;
  }
}

// Convert map back to array
candidateManifest.entries = Array.from(candidateMap.values());

fs.writeFileSync(candidatePath, JSON.stringify(candidateManifest, null, 2), 'utf-8');

console.log(`\n✅ Candidate manifest for ${country} updated successfully.`);
console.log(`   Added:   ${added}`);
console.log(`   Updated: ${updated}`);
console.log(`   Skipped: ${skipped} (Use --force to overwrite)`);
console.log(`   Total:   ${candidateManifest.entries.length}`);
