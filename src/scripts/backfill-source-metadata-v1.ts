import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { generateContentHash } from '@/lib/source-grounding/source-metadata';

type Options = {
  dryRun: boolean;
  batchSize: number;
};

type Summary = {
  dryRun: boolean;
  documentsScanned: number;
  documentsNeedingIndexVersion: number;
  chunksScanned: number;
  chunksNeedingContentHash: number;
  chunksUpdated: number;
};

function parseOptions(argv: string[]): Options {
  const dryRun = !argv.includes('--write');
  const batchArg = argv.find((arg) => arg.startsWith('--batch-size='));
  const batchSize = batchArg ? Number(batchArg.split('=')[1]) : 500;
  return {
    dryRun,
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 500,
  };
}

export async function backfillSourceMetadataV1(options: Options): Promise<Summary> {
  const summary: Summary = {
    dryRun: options.dryRun,
    documentsScanned: 0,
    documentsNeedingIndexVersion: 0,
    chunksScanned: 0,
    chunksNeedingContentHash: 0,
    chunksUpdated: 0,
  };

  const documents = await (prisma as any).regulatoryDocument.findMany({
    select: { id: true, indexVersion: true },
  });
  summary.documentsScanned = documents.length;
  summary.documentsNeedingIndexVersion = documents.filter((doc: { indexVersion?: string | null }) => !doc.indexVersion).length;

  if (!options.dryRun && summary.documentsNeedingIndexVersion > 0) {
    await (prisma as any).regulatoryDocument.updateMany({
      where: { OR: [{ indexVersion: null }, { indexVersion: '' }] },
      data: { indexVersion: 'v1' },
    });
  }

  let cursor: string | undefined;
  while (true) {
    const chunks = await (prisma as any).regulatoryDocumentChunk.findMany({
      take: options.batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, content: true, contentHash: true, indexVersion: true },
    });

    if (chunks.length === 0) break;

    summary.chunksScanned += chunks.length;
    cursor = chunks[chunks.length - 1].id;

    const updates = chunks
      .map((chunk: { id: string; content: string; contentHash?: string | null; indexVersion?: string | null }) => ({
        id: chunk.id,
        contentHash: chunk.contentHash || generateContentHash(chunk.content),
        indexVersion: chunk.indexVersion || 'v1',
        needsUpdate: !chunk.contentHash || !chunk.indexVersion,
      }))
      .filter((chunk: { needsUpdate: boolean }) => chunk.needsUpdate);

    summary.chunksNeedingContentHash += updates.length;

    if (!options.dryRun) {
      for (const update of updates) {
        await (prisma as any).regulatoryDocumentChunk.update({
          where: { id: update.id },
          data: {
            contentHash: update.contentHash,
            indexVersion: update.indexVersion,
          },
        });
        summary.chunksUpdated++;
      }
    }
  }

  logger.info({ type: 'source_metadata_v1_backfill_complete', ...summary });
  return summary;
}

if (require.main === module) {
  backfillSourceMetadataV1(parseOptions(process.argv.slice(2)))
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
