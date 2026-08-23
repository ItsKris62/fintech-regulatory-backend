import { getRuntimeAIConfig } from './src/lib/system-config';
import { prisma } from './src/lib/prisma/client';

async function main() {
  const config = await getRuntimeAIConfig('query');
  console.log(config);
  await prisma.$disconnect();
}
main();
