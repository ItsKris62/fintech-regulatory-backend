import { prisma } from '../lib/prisma/client';
import { getIndex } from '../lib/rag/client';
import * as fs from 'fs';

const TARGET_LIST = [
  'cmn4yrwto07u87gs5stdbdfsh',
  'cmn4ywa0y0b3x7gs5ydmqo0qf',
  'cmn4yur9c09pg7gs5adsfky3e',
  'cmn4yu1qy099i7gs5du0rnetn',
  'cmn4ytaof08x67gs5du0rnetn',
  'cmn4yt48q08uq7gs5d9jss2cp'
];

async function run() {
  const out = fs.createWriteStream('investigation-results.txt');
  function log(msg: string) { out.write(msg + '\n'); }

  log("Investigating v2 chunks and documents...\n");

  const v2Chunks = await (prisma as any).regulatoryDocumentChunk.findMany({
    where: { indexVersion: 'v2' },
    include: { document: true }
  });

  const docData: Record<string, any> = {};

  for (const chunk of v2Chunks) {
    if (!docData[chunk.documentId]) {
      docData[chunk.documentId] = {
        documentId: chunk.documentId,
        title: chunk.document?.title || 'Unknown Title',
        v2ChunkCount: 0,
        hasSourceDocVersion: 0
      };
    }
    docData[chunk.documentId].v2ChunkCount++;
    if (chunk.sourceDocumentVersionId) {
      docData[chunk.documentId].hasSourceDocVersion++;
    }
  }

  for (const id of TARGET_LIST) {
    if (!docData[id]) {
      const doc = await (prisma as any).regulatoryDocument.findUnique({ where: { id } });
      docData[id] = {
        documentId: id,
        title: doc?.title || 'Unknown/Deleted',
        v2ChunkCount: 0,
        hasSourceDocVersion: 0
      };
    }
  }

  log("Documents with v2 chunks or in target list:");
  for (const data of Object.values(docData)) {
    const inTargetList = TARGET_LIST.includes(data.documentId);
    log(`- Document ID: ${data.documentId}`);
    log(`  Title: ${data.title}`);
    log(`  v2 DB Chunks: ${data.v2ChunkCount}`);
    log(`  sourceDocumentVersionId coverage: ${data.hasSourceDocVersion} / ${data.v2ChunkCount}`);
    log(`  In Target List: ${inTargetList}`);
  }

  log("\nChecking Pinecone for the 0 DB chunk target docs...");
  const zeroChunkDocs = TARGET_LIST.filter(id => docData[id]?.v2ChunkCount === 0);
  
  const index = await getIndex();
  
  for (const id of zeroChunkDocs) {
    log(`Querying Pinecone for documentId: ${id}`);
    try {
      const response = await index.searchRecords({
        query: {
          inputs: { text: "finance regulation test" },
          topK: 100,
          filter: { documentId: id }
        }
      });
      log(`  Vectors found in search for ${id}: ${response.result.hits?.length || 0}`);
    } catch (e: any) {
      log(`  Error querying Pinecone for ${id}: ${e.message}`);
    }
  }
  out.end();
}

run().catch(console.error).finally(() => (prisma as any).$disconnect());
