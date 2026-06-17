import { prisma } from '../lib/prisma/client';

async function run() {
  const v2Chunks = await (prisma as any).regulatoryDocumentChunk.findMany({ where: { indexVersion: 'v2' } });
  
  const pilotIds = new Set(['cmn4yg9oq00007gs5edfsdmoh','cmn4ygxg500b17gs5mdtg5u9c','cmn4yle2p03c97gs5gepbd4uj']);
  const nonPilotChunks = v2Chunks.filter((c: any) => !pilotIds.has(c.documentId));
  
  let totalByDoc: Record<string, number> = {};
  let emptyCount = 0;
  let lengths: number[] = [];
  let duplicatesCount = 0;
  let seenHashes = new Set();
  
  let missingMetadata = 0;
  let invalidPageMeta = 0;
  
  for (const c of v2Chunks) {
    if (!totalByDoc[c.documentId]) totalByDoc[c.documentId] = 0;
    totalByDoc[c.documentId]++;
    
    if (!c.content || c.content.trim().length === 0 || c.content.trim().length < 10) emptyCount++;
    lengths.push(c.content ? c.content.length : 0);
    
    if (seenHashes.has(c.contentHash)) duplicatesCount++;
    seenHashes.add(c.contentHash);
    
    if (c.indexVersion !== 'v2' || !c.sourceDocumentVersionId || !c.contentHash || !c.provisionId || !c.documentId || c.chunkIndex == null) {
      missingMetadata++;
    }
    
    if (c.pageStart !== null || c.pageEnd !== null) invalidPageMeta++;
  }
  
  lengths.sort((a,b) => a-b);
  const min = lengths[0];
  const max = lengths[lengths.length-1];
  const avg = lengths.reduce((a,b)=>a+b,0) / lengths.length;
  
  console.log(JSON.stringify({
    total: v2Chunks.length,
    nonPilotChunksCount: nonPilotChunks.length,
    totalByDoc,
    emptyOrNearEmptyCount: emptyCount,
    duplicateHashCount: duplicatesCount,
    lengths: { min, max, avg: Math.round(avg) },
    missingMetadataCount: missingMetadata,
    falselyPopulatedPageMeta: invalidPageMeta,
    safeToUpsert: v2Chunks.length === 372 && nonPilotChunks.length === 0 && missingMetadata === 0 && invalidPageMeta === 0 && duplicatesCount === 0 && emptyCount === 0
  }, null, 2));
}

run().catch(console.error).finally(() => (prisma as any).$disconnect());
