import { describe, it, expect, vi } from 'vitest';
import { blogNotificationService } from '../modules/blog-automation/blog-notification.service';
import { blogEditorialDigestService } from '../modules/blog-automation/blog-editorial-digest.service';

// Mock redis
vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
  }
}));

// Mock notificationModule
vi.mock('../modules/notification', () => ({
  notificationModule: {
    createNotification: vi.fn(),
  }
}));

// Mock prisma
vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    blogEditorialDigest: {
      findFirst: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'digest-1', periodStart: new Date(), periodEnd: new Date() }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    blogSourceMonitor: {
      count: vi.fn().mockResolvedValue(5),
    },
    blogSourceItem: {
      count: vi.fn().mockResolvedValue(20),
    },
    blogSuggestion: {
      findMany: vi.fn().mockResolvedValue([{ priority: 'HIGH' }, { priority: 'URGENT' }]),
      count: vi.fn().mockResolvedValue(3),
    },
    blogPost: {
      count: vi.fn().mockResolvedValue(2),
    }
  }
}));

describe('BlogNotificationService', () => {
  it('should deduplicate notifications', async () => {
    const { notificationModule } = await import('../modules/notification');
    const { redis } = await import('@/lib/redis/client');

    vi.mocked(redis.get).mockResolvedValueOnce(null).mockResolvedValueOnce('1');
    
    await blogNotificationService.notifyMonitorFailure('admin-1', 'Test Monitor', 'Error');
    expect(notificationModule.createNotification).toHaveBeenCalledTimes(1);

    // Second call should be deduplicated
    await blogNotificationService.notifyMonitorFailure('admin-1', 'Test Monitor', 'Error');
    expect(notificationModule.createNotification).toHaveBeenCalledTimes(1);
  });
});

describe('BlogEditorialDigestService', () => {
  it('should generate a digest with correct metrics', async () => {
    const digest = await blogEditorialDigestService.generateBlogEditorialDigest();
    expect(digest).toBeDefined();
    expect(digest.id).toBe('digest-1');
  });
});
