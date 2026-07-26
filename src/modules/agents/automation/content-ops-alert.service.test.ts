import { describe, expect, it, vi } from 'vitest';
import { appConfig } from '@/config/app.config';
import { ContentOpsAlertService } from './content-ops-alert.service';

describe('ContentOpsAlertService', () => {
  it('sends via sendEmail to the fixed admin notification address with content_ops_alert tags', async () => {
    const sendEmail = vi.fn().mockResolvedValue({ id: 'email-1' });
    const service = new ContentOpsAlertService({ sendEmail });

    await service.sendAlert({
      subject: 'High Priority Blog Suggestion',
      summary: 'A high-priority suggestion was auto-approved and drafted.',
      details: ['Suggestion: sug_1'],
      link: 'https://app.sheriabot.com/admin/content/blog/post_1',
    });

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: appConfig.marketing.adminNotificationEmail,
      subject: 'High Priority Blog Suggestion',
      tags: [
        { name: 'category', value: 'content' },
        { name: 'type', value: 'content_ops_alert' },
      ],
    }));
  });

  it('does not send to a per-entity/per-monitor address - the recipient is always the fixed config value regardless of input', async () => {
    const sendEmail = vi.fn().mockResolvedValue({ id: 'email-1' });
    const service = new ContentOpsAlertService({ sendEmail });

    await service.sendAlert({ subject: 'x', summary: 'y' });
    await service.sendAlert({ subject: 'x', summary: 'y', details: ['irrelevant'] });

    const recipients = sendEmail.mock.calls.map((call) => call[0].to);
    expect(new Set(recipients)).toEqual(new Set([appConfig.marketing.adminNotificationEmail]));
  });

  it('logs and does not throw when sendEmail fails - an alert failure must never fail the calling automation flow', async () => {
    const sendEmail = vi.fn().mockRejectedValue(new Error('resend unavailable'));
    const service = new ContentOpsAlertService({ sendEmail });

    await expect(service.sendAlert({ subject: 'x', summary: 'y' })).resolves.toBeUndefined();
  });

  it('omits the details list and link when not provided', async () => {
    const sendEmail = vi.fn().mockResolvedValue({ id: 'email-1' });
    const service = new ContentOpsAlertService({ sendEmail });

    await service.sendAlert({ subject: 'x', summary: 'y' });

    const call = sendEmail.mock.calls[0][0];
    expect(call.html).not.toContain('<ul>');
    expect(call.html).not.toContain('<a href');
  });
});
