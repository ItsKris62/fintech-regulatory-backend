import { describe, expect, it, vi, beforeEach } from 'vitest';

const { notificationDedupe, createNotification } = vi.hoisted(() => ({
  notificationDedupe: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('@/lib/redis/dedupe', () => ({ notificationDedupe }));
vi.mock('../notification', () => ({ notificationModule: { createNotification } }));

import { BlogNotificationService } from './blog-notification.service';

const service = new BlogNotificationService();

describe('BlogNotificationService (regression - same inputs/outputs through the shared dedupe utility)', () => {
  beforeEach(() => {
    notificationDedupe.mockReset();
    createNotification.mockReset();
  });

  it('notifyMonitorFailure: dedupes on blog:notif:monitor_fail:<monitorName> with a 1-hour TTL, sends when claimed', async () => {
    notificationDedupe.mockResolvedValue(true);
    await service.notifyMonitorFailure('admin_1', 'CBK RSS Monitor', 'timeout contacting downstream service');

    expect(notificationDedupe).toHaveBeenCalledWith('blog:notif:monitor_fail:CBK RSS Monitor', 3600);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('notifyMonitorFailure: skips the notification when the dedupe gate was already claimed', async () => {
    notificationDedupe.mockResolvedValue(false);
    await service.notifyMonitorFailure('admin_1', 'CBK RSS Monitor', 'timeout contacting downstream service');

    expect(createNotification).not.toHaveBeenCalled();
  });

  it('notifyHighPrioritySuggestion: dedupes on blog:notif:high_priority_sugg:<suggestionId> with the default 24h TTL', async () => {
    notificationDedupe.mockResolvedValue(true);
    await service.notifyHighPrioritySuggestion('admin_1', 'CBK', 'sugg_1');

    expect(notificationDedupe).toHaveBeenCalledWith('blog:notif:high_priority_sugg:sugg_1', 86400);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('notifyDraftReadyForVerification: dedupes on blog:notif:draft_verify:<draftId> with the default 24h TTL', async () => {
    notificationDedupe.mockResolvedValue(true);
    await service.notifyDraftReadyForVerification('admin_1', 'draft_1');

    expect(notificationDedupe).toHaveBeenCalledWith('blog:notif:draft_verify:draft_1', 86400);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('notifyVerificationBlocked: dedupes on blog:notif:verify_blocked:<draftId> with a 12-hour TTL', async () => {
    notificationDedupe.mockResolvedValue(true);
    await service.notifyVerificationBlocked('admin_1', 'draft_1', 'source not found');

    expect(notificationDedupe).toHaveBeenCalledWith('blog:notif:verify_blocked:draft_1', 43200);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });
});
