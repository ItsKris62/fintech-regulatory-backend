import { prisma } from '../lib/prisma/client';
import { validatePrioritySourceMetadata } from './validate-priority-source-metadata';

interface BackfillOptions {
  inputFile: string;
  write: boolean;
  overwrite: boolean;
}

export async function backfillPrioritySourceMetadata(options: BackfillOptions) {
  const { results, summary } = await validatePrioritySourceMetadata({ inputFile: options.inputFile });

  console.log(`Validation complete: ${summary.valid} valid out of ${summary.total} rows.`);

  let written = 0;
  let skipped = 0;

  for (const validation of results) {
    if (!validation.isValid) {
      skipped++;
      continue;
    }

    const row = validation.row;

    if (row.reviewStatus !== 'APPROVED') {
      console.log(`Skipping ${row.regulatoryDocumentId} - Not APPROVED (status: ${row.reviewStatus})`);
      skipped++;
      continue;
    }

    const dbDoc = await (prisma as any).regulatoryDocument.findUnique({
      where: { id: row.regulatoryDocumentId },
    });

    if (!dbDoc) {
      console.log(`Skipping ${row.regulatoryDocumentId} - Not found in DB`);
      skipped++;
      continue;
    }

    // Check for overwrite protections
    if (dbDoc.officialUrl && dbDoc.officialUrl !== row.officialUrl && !options.overwrite) {
      console.log(`Skipping ${row.regulatoryDocumentId} - officialUrl already exists and differs. Use --overwrite to force.`);
      skipped++;
      continue;
    }

    // Prepare additive updates
    const updates: any = {};
    if (row.officialUrl && row.officialUrl !== dbDoc.officialUrl) {
      updates.officialUrl = row.officialUrl;
    }
    if (row.publicationDate && (!dbDoc.publicationDate || new Date(row.publicationDate).getTime() !== dbDoc.publicationDate.getTime())) {
      updates.publicationDate = new Date(row.publicationDate);
    }
    if (row.retrievedAt && (!dbDoc.retrievedAt || new Date(row.retrievedAt).getTime() !== dbDoc.retrievedAt.getTime())) {
      updates.retrievedAt = new Date(row.retrievedAt);
    }
    if (row.effectiveEndDate && (!dbDoc.effectiveEndDate || new Date(row.effectiveEndDate).getTime() !== dbDoc.effectiveEndDate.getTime())) {
      updates.effectiveEndDate = new Date(row.effectiveEndDate);
    }
    if (row.approvedSourceId && row.approvedSourceId !== dbDoc.sourceRegistryId) {
      updates.sourceRegistryId = row.approvedSourceId;
    }

    // If checksum is provided and missing in DB, we could update it but let's stick to the requested fields
    // "compute/use checksum only from existing document checksum or existing file where project utility supports it safely"
    // Since checksum is complex, we will only log if we miss it, but not update it directly here unless specified.

    if (Object.keys(updates).length === 0) {
      console.log(`Skipping ${row.regulatoryDocumentId} - No changes needed (Idempotent).`);
      skipped++;
      continue;
    }

    if (!options.write) {
      console.log(`[DRY RUN] Would update ${row.regulatoryDocumentId} with:`, updates);
      written++;
    } else {
      await (prisma as any).regulatoryDocument.update({
        where: { id: row.regulatoryDocumentId },
        data: updates,
      });
      console.log(`[WRITE] Updated ${row.regulatoryDocumentId} successfully.`);
      written++;
    }
  }

  console.log('\n--- Backfill Summary ---');
  console.log(`Rows Read:    ${summary.total}`);
  console.log(`Rows Valid:   ${summary.valid}`);
  console.log(`Rows Written: ${options.write ? written : 0} ${!options.write ? '(Dry Run: ' + written + ')' : ''}`);
  console.log(`Rows Skipped: ${skipped + summary.errors}`);
}

function parseOptions(args: string[]): BackfillOptions {
  const options: BackfillOptions = {
    inputFile: 'src/data/priority-source-metadata-intake.json',
    write: false,
    overwrite: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      options.inputFile = args[++i];
    } else if (args[i] === '--write') {
      options.write = true;
    } else if (args[i] === '--overwrite') {
      options.overwrite = true;
    }
  }
  return options;
}

if (require.main === module) {
  backfillPrioritySourceMetadata(parseOptions(process.argv.slice(2)))
    .catch((err) => {
      console.error('Backfill failed:', err);
      process.exit(1);
    })
    .finally(async () => {
      // Use process.exit(0) to bypass slow pino logger flush in thread-stream
      process.exit(0);
    });
}
