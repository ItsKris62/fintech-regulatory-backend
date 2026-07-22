import { describe, expect, it, vi } from 'vitest';
import { AutomationOutreachService } from './outreach.service';
import type { AutomationApprovalService } from './approval.service';

function approvalServiceStub(overrides: { status?: 'pending' | 'approved' | 'rejected'; metadata?: Record<string, unknown> } = {}) {
  return {
    getApproval: vi.fn().mockResolvedValue({ status: overrides.status ?? 'approved' }),
    requireMetadataField: vi.fn().mockImplementation(async (_id: string, field: string) => {
      const value = overrides.metadata?.[field];
      if (typeof value !== 'string') throw Object.assign(new Error('missing'), { code: 'BAD_REQUEST' });
      return value;
    }),
  } as unknown as AutomationApprovalService;
}

describe('AutomationOutreachService.queueOutreach', () => {
  it('refuses to send when the approval is not approved - hard gate, not advisory', async () => {
    const sendEmail = vi.fn();
    const service = new AutomationOutreachService({ approvalService: approvalServiceStub({ status: 'pending' }), sendEmail });

    await expect(service.queueOutreach({ approvalId: 'appr_1', orgId: 'org_1', content: 'Hi there' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses when the organization has no contactEmail, rather than fabricating a recipient', async () => {
    const prisma = {
      organization: { findUnique: vi.fn().mockResolvedValue({ contactEmail: null }) },
      salesOutreachDraft: { findUnique: vi.fn().mockResolvedValue({ subject: 'Subject' }), update: vi.fn() },
    };
    const sendEmail = vi.fn();
    const service = new AutomationOutreachService({
      prisma: prisma as never,
      approvalService: approvalServiceStub({ metadata: { draftId: 'draft_1' } }),
      sendEmail,
    });

    await expect(service.queueOutreach({ approvalId: 'appr_1', orgId: 'org_1', content: 'Hi there' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends via the shared sendEmail primitive (which already checks suppression), using the draft\'s own subject, then marks the draft QUEUED', async () => {
    const update = vi.fn();
    const prisma = {
      organization: { findUnique: vi.fn().mockResolvedValue({ contactEmail: 'ops@acme.test' }) },
      salesOutreachDraft: { findUnique: vi.fn().mockResolvedValue({ subject: 'Your compliance update' }), update },
    };
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: 'msg_1' });
    const service = new AutomationOutreachService({
      prisma: prisma as never,
      approvalService: approvalServiceStub({ metadata: { draftId: 'draft_1' } }),
      sendEmail,
    });

    const result = await service.queueOutreach({ approvalId: 'appr_1', orgId: 'org_1', content: '<p>Hi there</p>' });

    expect(result).toEqual({ orgId: 'org_1', sent: true, messageId: 'msg_1' });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'ops@acme.test', subject: 'Your compliance update', html: '<p>Hi there</p>' }));
    expect(update).toHaveBeenCalledWith({ where: { id: 'draft_1' }, data: { status: 'QUEUED' } });
  });

  it('reports sent:false, without throwing and without marking QUEUED, when sendEmail fails (e.g. suppressed recipient)', async () => {
    const update = vi.fn();
    const prisma = {
      organization: { findUnique: vi.fn().mockResolvedValue({ contactEmail: 'suppressed@acme.test' }) },
      salesOutreachDraft: { findUnique: vi.fn().mockResolvedValue({ subject: 'Subject' }), update },
    };
    const sendEmail = vi.fn().mockResolvedValue({ success: false, error: 'All recipients are suppressed' });
    const service = new AutomationOutreachService({
      prisma: prisma as never,
      approvalService: approvalServiceStub({ metadata: { draftId: 'draft_1' } }),
      sendEmail,
    });

    const result = await service.queueOutreach({ approvalId: 'appr_1', orgId: 'org_1', content: 'Hi' });
    expect(result).toEqual({ orgId: 'org_1', sent: false });
    expect(update).not.toHaveBeenCalled();
  });
});
