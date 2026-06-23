import { PrismaClient, BlogMonitorLastRunStatus, BlogDiscoveryRunStatus } from '@prisma/client';
import { isUrlSafe, normalizeUrl } from './url-safety';
import { acquireDiscoveryLock, releaseDiscoveryLock } from './discovery-lock';
import { generateContentHash } from './content-hash';
import { parseRssFeed } from './rss-parser';
import { parseHtmlListing } from './html-listing-parser';
import { blogNotificationService } from './blog-notification.service';

const prisma = new PrismaClient();

export async function runSourceDiscoveryForMonitor({
  monitorId,
  triggeredBy,
  triggeredByUserId,
}: {
  monitorId: string;
  triggeredBy: 'ADMIN' | 'CRON' | 'SYSTEM';
  triggeredByUserId?: string;
}) {
  // 1. Load monitor
  const monitor = await prisma.blogSourceMonitor.findUnique({
    where: { id: monitorId },
  });

  if (!monitor) {
    throw new Error(`Monitor ${monitorId} not found`);
  }

  // 2. Ensure monitor is active, verified, and not deleted
  if (!monitor.isActive || monitor.status !== 'ACTIVE' || monitor.verificationStatus !== 'VERIFIED' || monitor.deletedAt) {
    throw new Error(`Monitor ${monitorId} is not active and verified`);
  }

  // 3. Acquire lock
  const locked = await acquireDiscoveryLock(monitorId);
  if (!locked) {
    // If we can't acquire lock, create a skipped run log
    await prisma.blogDiscoveryRun.create({
      data: {
        monitorId,
        status: 'SKIPPED_LOCKED',
        errorMessage: 'Discovery skipped due to active lock',
        triggeredBy,
        triggeredByUserId,
      },
    });
    return { status: 'SKIPPED_LOCKED', message: 'Monitor is currently locked by another process' };
  }

  // 4. Create discovery run log
  const run = await prisma.blogDiscoveryRun.create({
    data: {
      monitorId,
      status: 'RUNNING',
      triggeredBy,
      triggeredByUserId,
    },
  });

  let itemsFound = 0;
  let itemsCreated = 0;
  let duplicateCount = 0;
  let failureCount = 0;
  let errorMessage: string | null = null;
  let finalStatus: BlogDiscoveryRunStatus = 'SUCCESS';
  let monitorStatus: BlogMonitorLastRunStatus = 'SUCCESS';

  try {
    // 5. Fetch source based on method
    let rawItems: any[] = [];
    const targetUrl = monitor.feedUrl || monitor.baseUrl;

    if (!isUrlSafe(targetUrl)) {
      throw new Error(`Unsafe URL detected: ${targetUrl}`);
    }

    if (monitor.monitoringMethod === 'RSS') {
      rawItems = await parseRssFeed(targetUrl, monitor.maxItemsPerRun, monitor.fetchTimeoutMs);
    } else if (monitor.monitoringMethod === 'HTML_LISTING') {
      rawItems = await parseHtmlListing(targetUrl, monitor.maxItemsPerRun, monitor.fetchTimeoutMs);
    } else if (monitor.monitoringMethod === 'API') {
      throw new Error('API monitoring not implemented yet');
    } else if (monitor.monitoringMethod === 'MANUAL') {
      throw new Error('Manual monitoring cannot be fetched');
    } else {
      throw new Error(`Unsupported method: ${monitor.monitoringMethod}`);
    }

    itemsFound = rawItems.length;

    // 6. Process items
    for (const item of rawItems) {
      if (!isUrlSafe(item.url)) {
        failureCount++;
        continue;
      }

      const itemNormalizedUrl = normalizeUrl(item.url);
      const contentHash = generateContentHash({
        monitorId,
        normalizedUrl: itemNormalizedUrl,
        title: item.title,
        publicationDate: item.publicationDate,
      });

      // 7. Duplicate detection
      const existing = await prisma.blogSourceItem.findFirst({
        where: {
          OR: [
            { monitorId, normalizedUrl: itemNormalizedUrl },
            { contentHash },
          ],
        },
      });

      if (existing) {
        duplicateCount++;
        continue;
      }

      // 8. Create new record
      try {
        await prisma.blogSourceItem.create({
          data: {
            monitorId,
            title: item.title,
            url: item.url,
            normalizedUrl: itemNormalizedUrl,
            summary: item.summary,
            publicationDate: item.publicationDate,
            contentHash,
            jurisdiction: monitor.jurisdiction,
            authorityType: monitor.authorityType,
            sourceType: monitor.sourceType,
            status: 'NEW',
          },
        });
        itemsCreated++;
      } catch (err) {
        console.error(`Failed to create item ${item.url}`, err);
        failureCount++;
      }
    }

    if (failureCount > 0 && itemsCreated === 0 && itemsFound > 0) {
      finalStatus = 'FAILED';
      monitorStatus = 'FAILED';
      errorMessage = 'All items failed to process';
    } else if (failureCount > 0) {
      finalStatus = 'PARTIAL_SUCCESS';
    }
  } catch (error: any) {
    errorMessage = error.message;
    finalStatus = 'FAILED';
    monitorStatus = 'FAILED';
  }

  // 10. Update monitor & Run Log
  try {
    const updateData: any = {
      lastCheckedAt: new Date(),
      lastRunStatus: monitorStatus,
    };

    if (monitorStatus === 'SUCCESS') {
      updateData.lastSuccessfulRunAt = new Date();
      updateData.failureCount = 0;
      updateData.lastFailureReason = null;
    } else {
      updateData.lastFailureAt = new Date();
      updateData.failureCount = monitor.failureCount + 1;
      if (updateData.failureCount >= 5) {
         updateData.status = 'FAILING';
         // Notify creator/admin if it fails 5 times or on failure?
      }
      
      // Notify monitor failure
      if (monitor.createdById) {
         await blogNotificationService.notifyMonitorFailure(
           monitor.createdById, 
           monitor.name, 
           errorMessage || 'Unknown error'
         ).catch(console.error);
      }
    }

    await prisma.blogSourceMonitor.update({
      where: { id: monitorId },
      data: updateData,
    });

    await prisma.blogDiscoveryRun.update({
      where: { id: run.id },
      data: {
        status: finalStatus,
        completedAt: new Date(),
        itemsFound,
        itemsCreated,
        duplicateCount,
        failureCount,
        errorMessage,
      },
    });
  } finally {
    // 12. Release lock
    await releaseDiscoveryLock(monitorId);
  }

  // 13. Return structured result
  return {
    status: finalStatus,
    itemsFound,
    itemsCreated,
    duplicateCount,
    failureCount,
    errorMessage,
  };
}
