import { prisma } from '../lib/prisma/client';
async function run() {
  await (prisma as any).regulatoryDocumentChunk.deleteMany({
    where: { indexVersion: 'v2', documentId: { in: ['cmn4yg9oq00007gs5edfsdmoh','cmn4ygxg500b17gs5mdtg5u9c','cmn4yle2p03c97gs5gepbd4uj'] } }
  });
  console.log('Deleted chunks');
}
run().finally(() => (prisma as any).$disconnect());
