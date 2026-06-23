import { notificationModule } from '../notification';
import { redis } from '@/lib/redis/client';


export class BlogNotificationService {
  private async shouldNotify(dedupeKey: string, ttlSeconds: number = 86400): Promise<boolean> {
    const exists = await redis.get(dedupeKey);
    if (exists) return false;
    await redis.set(dedupeKey, '1', { ex: ttlSeconds });
    return true;
  }

  async notifyMonitorFailure(adminId: string, monitorName: string, errorMsg: string) {
    const dedupeKey = `blog:notif:monitor_fail:${monitorName}`;
    if (!(await this.shouldNotify(dedupeKey, 3600))) return; // Dedupe 1 hour

    await notificationModule.createNotification({
      userId: adminId,
      type: 'BLOG_AUTOMATION',
      category: 'SYSTEM',
      title: 'Blog Monitor Failed',
      message: `Monitor "${monitorName}" failed: ${errorMsg.slice(0, 100)}...`,
      link: '/admin/content/blog/sources',
    });
  }

  async notifyHighPrioritySuggestion(adminId: string, sourceName: string, suggestionId: string) {
    const dedupeKey = `blog:notif:high_priority_sugg:${suggestionId}`;
    if (!(await this.shouldNotify(dedupeKey))) return;

    await notificationModule.createNotification({
      userId: adminId,
      type: 'BLOG_AUTOMATION',
      category: 'SYSTEM',
      title: 'High Priority Blog Suggestion',
      message: `A new high priority suggestion was generated from ${sourceName}.`,
      link: '/admin/content/blog',
    });
  }

  async notifyDraftReadyForVerification(adminId: string, draftId: string) {
    const dedupeKey = `blog:notif:draft_verify:${draftId}`;
    if (!(await this.shouldNotify(dedupeKey))) return;

    await notificationModule.createNotification({
      userId: adminId,
      type: 'BLOG_AUTOMATION',
      category: 'SYSTEM',
      title: 'Blog Draft Needs Verification',
      message: 'A new AI-generated draft is ready for compliance verification.',
      link: `/admin/content/blog/${draftId}`,
    });
  }

  async notifyVerificationBlocked(adminId: string, draftId: string, reason: string) {
    const dedupeKey = `blog:notif:verify_blocked:${draftId}`;
    if (!(await this.shouldNotify(dedupeKey, 43200))) return; // Dedupe 12 hours

    await notificationModule.createNotification({
      userId: adminId,
      type: 'BLOG_AUTOMATION',
      category: 'SYSTEM',
      title: 'Blog Verification Blocked',
      message: `A draft failed verification: ${reason}`,
      link: `/admin/content/blog/${draftId}`,
    });
  }
}

export const blogNotificationService = new BlogNotificationService();
