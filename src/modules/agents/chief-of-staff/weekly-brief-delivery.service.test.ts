import { describe, expect, it, vi } from 'vitest';
import { WeeklyBriefDeliveryService } from './weekly-brief-delivery.service';

describe('WeeklyBriefDeliveryService', () => {
  it('sends via sendEmail with weekly_brief tags to the admin notification address', async () => {
    const sendEmail = vi.fn().mockResolvedValue({ id: 'email-1' });
    const service = new WeeklyBriefDeliveryService({ sendEmail });

    await service.send({
      subject: 'SheriaBot Weekly Brief',
      summary: 'Quiet week.',
      wins: ['All services healthy.'],
      rankedActions: [{ action: 'Review draft.', sourceAgentType: 'marketing', sourceReportId: 'report-mk' }],
      decisionsNeeded: [],
      agentRunId: 'run-1',
    });

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'SheriaBot Weekly Brief',
      tags: [
        { name: 'category', value: 'operations' },
        { name: 'type', value: 'weekly_brief' },
      ],
    }));
  });

  it('logs and does not throw when sendEmail fails - a delivery failure must never fail the agent run', async () => {
    const sendEmail = vi.fn().mockRejectedValue(new Error('resend unavailable'));
    const service = new WeeklyBriefDeliveryService({ sendEmail });

    await expect(service.send({
      subject: 'x', summary: 'y', wins: [], rankedActions: [], decisionsNeeded: [], agentRunId: 'run-1',
    })).resolves.toBeUndefined();
  });
});
