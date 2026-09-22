import 'dotenv/config';
import { prisma } from '../lib/prisma/client';
import { loadSystemConfig, SYSTEM_CONFIG_DEFINITIONS } from '../lib/system-config';

async function main() {
  console.log('🔄 Syncing system config definitions into database...');

  // 1. Sync definitions via system-config loader
  await loadSystemConfig({ syncDefinitions: true });

  // 2. Query count in database
  const rowCount = await prisma.systemConfig.count();
  console.log(`✅ SystemConfig table successfully synced. Total rows: ${rowCount}`);

  const activeDefinitions = SYSTEM_CONFIG_DEFINITIONS.length;
  console.log(`✅ Standard config definitions synced: ${activeDefinitions}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('❌ Failed to sync system config:', err);
  process.exit(1);
});
