import { describe, expect, it, vi } from 'vitest';
import { AutomationNewsletterService } from './newsletter.service';
import type { AutomationApprovalService } from './approval.service';

describe('AutomationNewsletterService.sendNewsletter', () => {
  it('enforces the approval gate before anything else - rejects a non-approved approval', async () => {
    const approvalService = { getApproval: vi.fn().mockResolvedValue({ status: 'pending' }) } as unknown as AutomationApprovalService;
    const service = new AutomationNewsletterService({ approvalService });

    await expect(service.sendNewsletter({ approvalId: 'appr_1', html: '<p>hi</p>' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('throws NOT_IMPLEMENTED (not a silent fake success) once approved, since no real send path exists yet', async () => {
    const approvalService = { getApproval: vi.fn().mockResolvedValue({ status: 'approved' }) } as unknown as AutomationApprovalService;
    const service = new AutomationNewsletterService({ approvalService });

    await expect(service.sendNewsletter({ approvalId: 'appr_1', html: '<p>hi</p>' })).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });
});
