import { prisma } from './src/lib/prisma/client';

async function main() {
  const configs = await prisma.systemConfig.findMany({
    where: { key: { in: ['availableAIModels', 'available_ai_models', 'ai_query_model', 'aiQueryModel'] } }
  });
  console.log(configs);
  await prisma.$disconnect();
}
main();
