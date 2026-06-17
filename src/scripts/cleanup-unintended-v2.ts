import { prisma } from '../lib/prisma/client';

const UNINTENDED_DOC_IDS = [
  'cmn4yrwto07u87gs5stdbdfsh', // POCAMLA Act
  'cmn4ywa0y0b3x7gs5ydmqo0qf', // NIST AI RMF
  'cmn4yur9c09pg7gs5p3myyhwm', // Kenya Cloud Policy (Fixed ID)
  'cmn4yu1qy099i7gs5adsfky3e', // GDPR (Fixed ID)
  'cmn4ytaof08x67gs5du0rnetn', // NIST CSF Examples
  'cmn4yt48q08uq7gs5d9jss2cp'  // NIST CSF 2.0
];

async function run() {
  const isDryRun = !process.argv.includes('--write');
  
  console.log(`Starting targeted cleanup of unintended v2 data...`);
  console.log(`Mode: ${isDryRun ? 'DRY RUN' : 'WRITE (DANGEROUS)'}`);

  // Fetch v2 chunks for the unintended docs
  const unintendedChunks = await (prisma as any).regulatoryDocumentChunk.findMany({
    where: {
      documentId: { in: UNINTENDED_DOC_IDS },
      indexVersion: 'v2'
    }
  });

  // Calculate totals by doc
  const byDoc: Record<string, { chunks: number, pineconeIds: string[], chunkIds: string[] }> = {};
  for (const id of UNINTENDED_DOC_IDS) {
    byDoc[id] = { chunks: 0, pineconeIds: [], chunkIds: [] };
  }

  for (const chunk of unintendedChunks) {
    byDoc[chunk.documentId].chunks++;
    if (chunk.pineconeId) {
      byDoc[chunk.documentId].pineconeIds.push(chunk.pineconeId);
    }
    byDoc[chunk.documentId].chunkIds.push(chunk.id);
  }

  // Count total intended v2 chunks (just for verification)
  const totalV2ChunksBefore = await (prisma as any).regulatoryDocumentChunk.count({
    where: { indexVersion: 'v2' }
  });

  console.log('\n--- REPORT ---');
  let totalChunksToDel = 0;
  for (const [docId, data] of Object.entries(byDoc)) {
    console.log(`Doc: ${docId}`);
    console.log(`  v2 DB chunks to delete: ${data.chunks}`);
    console.log(`  Pinecone vector IDs to delete: ${data.pineconeIds.length}`);
    totalChunksToDel += data.chunks;
  }

  console.log('\n--- TOTALS ---');
  console.log(`Total DB chunks affected: ${totalChunksToDel}`);
  console.log(`Total vectors affected: ${totalChunksToDel}`);
  
  const intendedV2Count = totalV2ChunksBefore - totalChunksToDel;
  console.log(`Total v2 chunks before cleanup: ${totalV2ChunksBefore}`);
  console.log(`Intended v2 chunks that will remain untouched: ${intendedV2Count}`);

  // The intended 7 documents check: we know total V2 docs should be 7 + 6 = 13.
  const docsWithV2 = await (prisma as any).regulatoryDocumentChunk.groupBy({
    by: ['documentId'],
    where: { indexVersion: 'v2' }
  });
  
  const totalV2Docs = docsWithV2.length;
  const intendedV2Docs = docsWithV2.filter((d: any) => !UNINTENDED_DOC_IDS.includes(d.documentId)).length;
  console.log(`\nTotal docs with v2 data: ${totalV2Docs}`);
  console.log(`Intended v2 docs remaining: ${intendedV2Docs}`);
  if (intendedV2Docs === 7) {
    console.log(`✅ Verified: The intended 7 v2 documents will remain untouched.`);
  } else {
    console.log(`⚠️ Warning: Expected 7 intended v2 documents, but found ${intendedV2Docs}.`);
  }

  // Actually delete
  if (!isDryRun) {
    console.log('\n--- EXECUTING DELETIONS ---');
    for (const [docId, data] of Object.entries(byDoc)) {
      if (data.pineconeIds.length > 0) {
        // Pinecone deletion
        console.log(`Deleting vectors for doc ${docId} using filter...`);
        const { deleteByFilter } = require('../lib/rag/client');
        await deleteByFilter({ documentId: docId, indexVersion: 'v2' });

        
        // DB deletion
        console.log(`Deleting ${data.chunkIds.length} DB chunks for doc ${docId}...`);
        await (prisma as any).regulatoryDocumentChunk.deleteMany({
          where: { id: { in: data.chunkIds } }
        });
      }
    }
    console.log('Cleanup completed.');
  } else {
    console.log('\nDry run completed. Run with --write to actually delete.');
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
}).finally(() => (prisma as any).$disconnect());
