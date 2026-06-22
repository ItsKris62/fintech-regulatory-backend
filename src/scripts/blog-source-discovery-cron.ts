import { PrismaClient } from '@prisma/client';
import { runSourceDiscoveryForMonitor } from '../modules/blog-automation/source-discovery.service';

const prisma = new PrismaClient();

async function main() {
  console.log('[Blog Discovery Cron] Starting...');

  const activeMonitors = await prisma.blogSourceMonitor.findMany({
    where: {
      isActive: true,
      status: 'ACTIVE',
      verificationStatus: 'VERIFIED',
      deletedAt: null,
    },
  });

  console.log(`[Blog Discovery Cron] Found ${activeMonitors.length} active monitors to process.`);

  // Limit concurrency to 2 to avoid overwhelming backend/redis
  const CONCURRENCY = 2;
  
  for (let i = 0; i < activeMonitors.length; i += CONCURRENCY) {
    const chunk = activeMonitors.slice(i, i + CONCURRENCY);
    
    await Promise.all(
      chunk.map(async (monitor) => {
        try {
          console.log(`[Blog Discovery Cron] Running monitor ${monitor.name} (${monitor.id})`);
          const result = await runSourceDiscoveryForMonitor({
            monitorId: monitor.id,
            triggeredBy: 'CRON',
          });
          console.log(`[Blog Discovery Cron] Monitor ${monitor.name} finished:`, result);
        } catch (error) {
          console.error(`[Blog Discovery Cron] Error running monitor ${monitor.name}:`, error);
        }
      })
    );
  }

  console.log('[Blog Discovery Cron] Completed.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
