import 'dotenv/config';
import { prisma } from '../lib/prisma/client';

async function main() {
  const count = await prisma.organization.count();
  console.log('CONNECTED_TO_ISOLATED_DB, ORG_COUNT =', count);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
