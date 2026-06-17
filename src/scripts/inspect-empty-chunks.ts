import { prisma } from '../lib/prisma/client';
async function run() {
  const chunks = await (prisma as any).regulatoryDocumentChunk.findMany({ where: { indexVersion: 'v2' } });
  const empty = chunks.filter((c: any) => !c.content || c.content.trim().length < 10);
  console.log(JSON.stringify(empty.map((c: any) => ({ doc: c.documentId, content: c.content })), null, 2));
}
run().finally(() => (prisma as any).$disconnect());
