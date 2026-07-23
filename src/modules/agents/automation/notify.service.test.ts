import { describe, expect, it, vi } from 'vitest';
import { AutomationNotifyService } from './notify.service';

describe('AutomationNotifyService.shouldNotify', () => {
  it('returns { shouldNotify: true } and forwards dedupeKey/ttlSeconds when the gate is claimed', async () => {
    const notificationDedupe = vi.fn().mockResolvedValue(true);
    const service = new AutomationNotifyService({ notificationDedupe });

    const result = await service.shouldNotify({ dedupeKey: 'W-SEC-01:issue_123', ttlSeconds: 3600 });

    expect(result).toEqual({ shouldNotify: true });
    expect(notificationDedupe).toHaveBeenCalledWith('W-SEC-01:issue_123', 3600);
  });

  it('returns { shouldNotify: false } when the key was already claimed within the TTL', async () => {
    const notificationDedupe = vi.fn().mockResolvedValue(false);
    const service = new AutomationNotifyService({ notificationDedupe });

    const result = await service.shouldNotify({ dedupeKey: 'W-SEC-01:issue_123', ttlSeconds: 3600 });

    expect(result).toEqual({ shouldNotify: false });
  });
});
