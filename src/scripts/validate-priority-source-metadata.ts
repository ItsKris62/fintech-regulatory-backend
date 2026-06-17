import fs from 'fs';
import path from 'path';
import { prisma } from '../lib/prisma/client';
import { isOfficialUrlAllowed, normalizeOfficialUrl } from '../lib/source-grounding/source-metadata';
import { PrioritySourceMetadataIntakeSchema, PrioritySourceMetadataIntake } from '../lib/source-grounding/intake-schema';

interface Options {
  inputFile: string;
}

export type ValidationResult = {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  notes: string[];
  row: PrioritySourceMetadataIntake;
};

export async function validatePrioritySourceMetadata(options: Options): Promise<{
  results: ValidationResult[];
  summary: { total: number; valid: number; errors: number; warnings: number };
}> {
  const content = fs.readFileSync(path.resolve(options.inputFile), 'utf-8');
  let data: any[];
  try {
    data = JSON.parse(content);
  } catch (e) {
    throw new Error('Invalid JSON input file.');
  }

  const results: ValidationResult[] = [];
  const summary = { total: data.length, valid: 0, errors: 0, warnings: 0 };

  const seenUrls = new Set<string>();

  for (const rawRow of data) {
    const parseResult = PrioritySourceMetadataIntakeSchema.safeParse(rawRow);
    if (!parseResult.success) {
      results.push({
        isValid: false,
        errors: [`Invalid schema: ${parseResult.error.message}`],
        warnings: [],
        notes: [],
        row: rawRow as PrioritySourceMetadataIntake,
      });
      summary.errors++;
      continue;
    }

    const row = parseResult.data;
    const validation: ValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
      notes: [],
      row,
    };

    if (row.notes) {
      validation.notes.push(row.notes);
    }

    if (row.reviewStatus !== 'APPROVED') {
      validation.notes.push(`Row is not APPROVED (status: ${row.reviewStatus}). It will be skipped during write.`);
    }

    if (!row.officialUrl && row.reviewStatus === 'APPROVED') {
      validation.errors.push('officialUrl is required for APPROVED rows.');
      validation.isValid = false;
    }

    if (row.officialUrl) {
      if (row.officialUrl.includes('example-placeholder-url.com') || row.officialUrl.includes('example')) {
        validation.errors.push('Placeholder or example URL detected.');
        validation.isValid = false;
      }
      if (!row.officialUrl.startsWith('https://')) {
        validation.errors.push('officialUrl must use HTTPS.');
        validation.isValid = false;
      }

      const normUrl = normalizeOfficialUrl(row.officialUrl);
      if (normUrl) {
        if (seenUrls.has(normUrl)) {
          validation.errors.push('Duplicate officialUrl detected in intake file.');
          validation.isValid = false;
        }
        seenUrls.add(normUrl);
      } else {
        validation.errors.push('officialUrl could not be normalized.');
        validation.isValid = false;
      }
    }

    if (!row.checksumSha256) {
      validation.warnings.push('missing checksumSha256. If document exists, existing checksum will be used.');
    }

    // DB validation
    const dbDoc = await (prisma as any).regulatoryDocument.findUnique({
      where: { id: row.regulatoryDocumentId },
    });
    if (!dbDoc) {
      validation.errors.push(`RegulatoryDocument ${row.regulatoryDocumentId} not found in database.`);
      validation.isValid = false;
    } else {
      if (!dbDoc.title.toLowerCase().includes(row.normalizedTitle.toLowerCase()) && 
          !row.normalizedTitle.toLowerCase().includes(dbDoc.title.toLowerCase())) {
        validation.warnings.push(`Intake normalizedTitle "${row.normalizedTitle}" differs significantly from DB title "${dbDoc.title}".`);
      }
      if (dbDoc.jurisdiction !== row.jurisdiction) {
        validation.errors.push(`Jurisdiction mismatch: intake=${row.jurisdiction}, DB=${dbDoc.jurisdiction}`);
        validation.isValid = false;
      }
    }

    if (row.approvedSourceId) {
      const dbSource = await (prisma as any).approvedSource.findUnique({
        where: { id: row.approvedSourceId },
      });
      if (!dbSource) {
        validation.errors.push(`ApprovedSource ${row.approvedSourceId} not found in database.`);
        validation.isValid = false;
      } else {
        if (row.officialUrl && !isOfficialUrlAllowed(row.officialUrl, dbSource)) {
          validation.errors.push(`officialUrl "${row.officialUrl}" is not allowed by ApprovedSource ${row.approvedSourceId} domains.`);
          validation.isValid = false;
        }
      }
    }

    results.push(validation);
    if (validation.isValid) {
      summary.valid++;
    } else {
      summary.errors++;
    }
    if (validation.warnings.length > 0) {
      summary.warnings++;
    }
  }

  return { results, summary };
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    inputFile: 'src/data/priority-source-metadata-intake.json',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      options.inputFile = args[++i];
    }
  }
  return options;
}

if (require.main === module) {
  validatePrioritySourceMetadata(parseOptions(process.argv.slice(2)))
    .then(({ summary, results }) => {
      console.log('Validation Results:');
      for (const res of results) {
        console.log(`\nDocument: ${res.row.regulatoryDocumentId} (${res.row.normalizedTitle})`);
        console.log(`  Valid: ${res.isValid}`);
        res.errors.forEach(e => console.log(`  ERROR: ${e}`));
        res.warnings.forEach(w => console.log(`  WARN:  ${w}`));
        res.notes.forEach(n => console.log(`  NOTE:  ${n}`));
      }
      console.log('\nSummary:', summary);
      if (summary.errors > 0) {
        process.exit(1);
      } else {
        process.exit(0);
      }
    })
    .catch((err) => {
      console.error('Validation failed:', err);
      process.exit(1);
    });
}
