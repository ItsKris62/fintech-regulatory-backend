import 'dotenv/config';

import { prisma } from '../lib/prisma/client';
import { getIndex, getIndexStats, getPineconeDiagnostics, resolvePineconeNamespace } from '../lib/rag/client';

function distribution(values: Array<string | null | undefined>): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = value ?? '(missing)';
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicateSet = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicateSet.add(value);
    seen.add(value);
  }
  return [...duplicateSet];
}

async function main() {
  const documents = await prisma.regulatoryDocument.findMany({
    select: {
      id: true,
      title: true,
      checksum: true,
      indexVersion: true,
      jurisdiction: true,
      jurisdictionCode: true,
      status: true,
      chunkCount: true,
      createdAt: true,
      updatedAt: true,
      metadata: true,
      chunks: {
        select: {
          id: true,
          pineconeId: true,
          chunkIndex: true,
          contentHash: true,
          indexVersion: true,
          jurisdictionCode: true,
          metadata: true,
          createdAt: true,
        },
        orderBy: { chunkIndex: 'asc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const dpa = documents.find((document) => {
    const metadata = document.metadata as Record<string, unknown> | null;
    return metadata?.frameworkSlug === 'dpa-2019' || /data protection act/i.test(document.title);
  });
  if (!dpa) throw new Error('Expected approved Kenya DPA document was not found.');

  const namespace = resolvePineconeNamespace();
  const index = await getIndex();
  const stats = await getIndexStats();
  const dbChunkIds = dpa.chunks.map((chunk) => chunk.pineconeId);
  const namespaceMatches: Record<string, { vectorIds: Set<string>; records: Array<Record<string, unknown>> }> = {};
  for (const namespaceName of Object.keys(stats.namespaces ?? {})) {
    const match = { vectorIds: new Set<string>(), records: [] as Array<Record<string, unknown>> };
    for (let offset = 0; offset < dpa.chunks.length; offset += 100) {
      const ids = dbChunkIds.slice(offset, offset + 100);
      const response = await index.fetch({ ids, namespace: namespaceName });
      for (const id of Object.keys(response.records)) match.vectorIds.add(id);
      match.records.push(...Object.values(response.records).map((record) => record.metadata ?? {}));
    }
    namespaceMatches[namespaceName] = match;
  }
  const corpusNamespace = Object.entries(namespaceMatches)
    .sort(([, left], [, right]) => right.vectorIds.size - left.vectorIds.size)[0]?.[0] ?? namespace;
  const vectorIds = namespaceMatches[corpusNamespace]?.vectorIds ?? new Set<string>();
  const records = namespaceMatches[corpusNamespace]?.records ?? [];
  const missingFromPinecone = dbChunkIds.filter((id) => !vectorIds.has(id));
  const metadata = records as Array<{
    documentId?: string;
    frameworkSlug?: string;
    jurisdictionCode?: string;
    indexVersion?: string;
    documentChecksum?: string;
    authorityStatus?: string;
    isBinding?: boolean;
  }>;

  console.log(JSON.stringify({
    pinecone: {
      ...getPineconeDiagnostics(namespace),
      totalRecordCount: stats.totalRecordCount,
      namespaceRecordCount: stats.namespaces?.[namespace]?.recordCount ?? null,
      namespaceRecordCounts: Object.fromEntries(
        Object.entries(stats.namespaces ?? {}).map(([name, value]) => [name, value.recordCount ?? 0]),
      ),
      testedDocumentMatchesByNamespace: Object.fromEntries(
        Object.entries(namespaceMatches).map(([name, value]) => [name, value.vectorIds.size]),
      ),
      detectedCorpusNamespace: corpusNamespace,
    },
    database: {
      documentCount: documents.length,
      chunkCount: documents.reduce((sum, document) => sum + document.chunks.length, 0),
      documentIds: distribution(documents.map((document) => document.id)),
    },
    testedDocument: {
      id: dpa.id,
      title: dpa.title,
      status: dpa.status,
      checksum: dpa.checksum,
      indexVersion: dpa.indexVersion,
      jurisdiction: dpa.jurisdiction,
      jurisdictionCode: dpa.jurisdictionCode,
      declaredChunkCount: dpa.chunkCount,
      actualDbChunkCount: dpa.chunks.length,
      vectorCountByDbIdSet: vectorIds.size,
      fetchedVectorMetadataCount: records.length,
      missingDbChunkIdsInPinecone: missingFromPinecone.length,
      duplicatePineconeIdsInDb: duplicates(dbChunkIds).length,
      duplicateChunkIndexesInDb: duplicates(dpa.chunks.map((chunk) => String(chunk.chunkIndex))).length,
      duplicateContentHashesInDb: duplicates(dpa.chunks.map((chunk) => chunk.contentHash).filter((value): value is string => !!value)).length,
      dbIndexVersionDistribution: distribution(dpa.chunks.map((chunk) => chunk.indexVersion)),
      dbJurisdictionCodeDistribution: distribution(dpa.chunks.map((chunk) => chunk.jurisdictionCode)),
      dbFrameworkSlugDistribution: distribution(dpa.chunks.map((chunk) => (chunk.metadata as Record<string, string> | null)?.frameworkSlug)),
      vectorDocumentIdDistribution: distribution(metadata.map((item) => item.documentId)),
      vectorFrameworkSlugDistribution: distribution(metadata.map((item) => item.frameworkSlug)),
      vectorJurisdictionCodeDistribution: distribution(metadata.map((item) => item.jurisdictionCode)),
      vectorIndexVersionDistribution: distribution(metadata.map((item) => item.indexVersion)),
      vectorChecksumDistribution: distribution(metadata.map((item) => item.documentChecksum)),
      vectorAuthorityStatusDistribution: distribution(metadata.map((item) => item.authorityStatus)),
      vectorBindingDistribution: distribution(metadata.map((item) => item.isBinding === undefined ? undefined : String(item.isBinding))),
      documentMetadataKeys: Object.keys((dpa.metadata as Record<string, unknown> | null) ?? {}).sort(),
      firstChunkCreatedAt: dpa.chunks[0]?.createdAt ?? null,
      lastChunkCreatedAt: dpa.chunks.at(-1)?.createdAt ?? null,
      documentCreatedAt: dpa.createdAt,
      documentUpdatedAt: dpa.updatedAt,
    },
  }, null, 2));
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    await prisma.$disconnect();
    process.exit(1);
  });
