import { describe, expect, it, vi } from 'vitest';
import { SecurityOpsAlertService } from './ops-alert.service';

describe('SecurityOpsAlertService', () => {
  it('sends via sendEmail with security_ops_alert tags to the admin notification address', async () => {
    const sendEmail = vi.fn().mockResolvedValue({ id: 'email-1' });
    const service = new SecurityOpsAlertService({ sendEmail });

    await service.sendAlert({
      subject: 'Database check reported down',
      summary: 'Database check reported down this window.',
      risks: ['database check reported status: down'],
      agentRunId: 'run-1',
    });

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Database check reported down',
      tags: [
        { name: 'category', value: 'security' },
        { name: 'type', value: 'security_ops_alert' },
      ],
    }));
  });

  it('logs and does not throw when sendEmail fails - an alert failure must never fail the agent run', async () => {
    const sendEmail = vi.fn().mockRejectedValue(new Error('resend unavailable'));
    const service = new SecurityOpsAlertService({ sendEmail });

    await expect(service.sendAlert({
      subject: 'x', summary: 'y', risks: [], agentRunId: 'run-1',
    })).resolves.toBeUndefined();
  });
});
