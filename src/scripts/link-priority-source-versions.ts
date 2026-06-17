import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import {
  buildSourceDocumentVersionId,
  isPriorityRegulatoryDocument,
  matchApprovedSourceId,
} from '@/lib/source-grounding/approved-sources';
import { normalizeOfficialUrl } from '@/lib/source-grounding/source-metadata';

type Options = {
  dryRun: boolean;
  limit?: number;
};

type LinkSummary = {
  dryRun: boolean;
  scanned: number;
  priorityDocuments: number;
  linked: number;
  skipped: number;
  missingOfficialUrl: string[];
  missingChecksum: string[];
  manualReview: Array<{ id: string; title: string; reason: string }>;
};

function parseOptions(argv: string[]): Options {
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;
  return {
    dryRun: !argv.includes('--write'),
    limit: Number.isFinite(limit) && limit && limit > 0 ? limit : undefined,
  };
}

export async function linkPrioritySourceVersions(options: Options): Promise<LinkSummary> {
  const summary: LinkSummary = {
    dryRun: options.dryRun,
    scanned: 0,
    priorityDocuments: 0,
    linked: 0,
    skipped: 0,
    missingOfficialUrl: [],
    missingChecksum: [],
    manualReview: [],
  };

  const documents = await (prisma as any).regulatoryDocument.findMany({
    take: options.limit,
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      title: true,
      source: true,
      category: true,
      documentType: true,
      officialUrl: true,
      publicationDate: true,
      retrievedAt: true,
      effectiveDate: true,
      effectiveEndDate: true,
      version: true,
      checksum: true,
      authorityStatus: true,
      isBinding: true,
      status: true,
    },
  });

  summary.scanned = documents.length;

  for (const doc of documents) {
    if (!isPriorityRegulatoryDocument(doc)) continue;
    summary.priorityDocuments++;

    const approvedSourceId = matchApprovedSourceId(doc);
    const officialUrl = normalizeOfficialUrl(doc.officialUrl ?? '');

    if (!approvedSourceId) {
      summary.skipped++;
      summary.manualReview.push({ id: doc.id, title: doc.title, reason: 'No approved source match from existing source/title/category metadata.' });
      continue;
    }

    if (!officialUrl) {
      summary.skipped++;
      summary.missingOfficialUrl.push(doc.id);
      summary.manualReview.push({ id: doc.id, title: doc.title, reason: 'Missing manifest-backed officialUrl; source version not created.' });
      continue;
    }

    if (!doc.checksum) {
      summary.missingChecksum.push(doc.id);
    }

    const versionId = buildSourceDocumentVersionId({
      regulatoryDocumentId: doc.id,
      officialUrl,
      checksumSha256: doc.checksum,
      versionLabel: doc.version,
    });

    const versionData = {
      regulatoryDocumentId: doc.id,
      approvedSourceId,
      officialUrl,
      publicationDate: doc.publicationDate ?? null,
      retrievedAt: doc.retrievedAt ?? null,
      effectiveDate: doc.effectiveDate ?? null,
      effectiveEndDate: doc.effectiveEndDate ?? null,
      versionLabel: doc.version ?? null,
      checksumSha256: doc.checksum ?? null,
      authorityStatus: doc.authorityStatus ?? 'IN_FORCE',
      isBinding: doc.isBinding ?? null,
      status: doc.status === 'SUPERSEDED' ? 'SUPERSEDED' : 'ACTIVE',
    };

    summary.linked++;
    if (!options.dryRun) {
      await (prisma as any).sourceDocumentVersion.upsert({
        where: { id: versionId },
        create: { id: versionId, ...versionData },
        update: versionData,
      });
      await (prisma as any).regulatoryDocument.update({
        where: { id: doc.id },
        data: {
          sourceRegistryId: approvedSourceId,
          sourceDocumentVersionId: versionId,
        },
      });
    }
  }

  logger.info({ type: 'priority_source_versions_link_complete', ...summary });
  return summary;
}

if (require.main === module) {
  linkPrioritySourceVersions(parseOptions(process.argv.slice(2)))
    .then((summary) => { require('fs').writeFileSync('link-summary.json', JSON.stringify(summary, null, 2)); console.log('Saved to link-summary.json'); process.exit(0); })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
