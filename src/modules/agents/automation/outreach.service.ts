import { TRPCError } from '@trpc/server';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { sendEmail as defaultSendEmail, type EmailOptions, type EmailResult } from '@/lib/email/client';
import { automationApprovalService as defaultAutomationApprovalService, type AutomationApprovalService } from './approval.service';

type SendEmailFn = (options: EmailOptions) => Promise<EmailResult>;

type OutreachPrisma = Pick<typeof defaultPrisma, 'organization' | 'salesOutreachDraft'>;

export interface AutomationOutreachServiceDependencies {
  prisma?: OutreachPrisma;
  approvalService?: AutomationApprovalService;
  sendEmail?: SendEmailFn;
}

export interface QueueOutreachInput {
  approvalId: string;
  orgId: string;
  content: string;
}

export class AutomationOutreachService {
  private readonly prisma: OutreachPrisma;
  private readonly approvalService: AutomationApprovalService;
  private readonly sendEmail: SendEmailFn;

  constructor(dependencies: AutomationOutreachServiceDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as OutreachPrisma);
    this.approvalService = dependencies.approvalService ?? defaultAutomationApprovalService;
    this.sendEmail = dependencies.sendEmail ?? defaultSendEmail;
  }

  /**
   * Hard gate: approval must be 'approved' before anything sends - this is
   * customer-facing (per the brief, "treat the approval check as a hard
   * gate, not advisory"). approval.metadata must carry { draftId } pointing
   * at the SalesOutreachDraft this approval is for - queueOutreach's own
   * input has no subject field, and the draft is the only place a subject
   * line exists, so the link has to travel through metadata (same pattern as
   * publishContent's blogPostId). Reuses the existing sendEmail() primitive,
   * which already checks SuppressionList before sending - not a bespoke send
   * path that would bypass it.
   */
  async queueOutreach(input: QueueOutreachInput): Promise<{ orgId: string; sent: boolean; messageId?: string }> {
    const approval = await this.approvalService.getApproval({ approvalId: input.approvalId });
    if (approval.status !== 'approved') {
      throw new TRPCError({ code: 'FORBIDDEN', message: `Approval ${input.approvalId} is not approved (status: ${approval.status}).` });
    }

    const draftId = await this.approvalService.requireMetadataField(input.approvalId, 'draftId');

    const [draft, org] = await Promise.all([
      this.prisma.salesOutreachDraft.findUnique({ where: { id: draftId }, select: { subject: true } }),
      this.prisma.organization.findUnique({ where: { id: input.orgId }, select: { contactEmail: true } }),
    ]);

    if (!draft) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `SalesOutreachDraft ${draftId} not found.` });
    }
    if (!org?.contactEmail) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `Organization ${input.orgId} has no contactEmail on file - cannot send outreach.` });
    }

    const result = await this.sendEmail({
      to: org.contactEmail,
      subject: draft.subject,
      html: input.content,
      tags: [{ name: 'category', value: 'sales-outreach' }],
    });

    if (!result.success) {
      logger.warn({ type: 'automation_outreach_send_failed', approvalId: input.approvalId, orgId: input.orgId, error: result.error });
      return { orgId: input.orgId, sent: false };
    }

    await this.prisma.salesOutreachDraft.update({ where: { id: draftId }, data: { status: 'QUEUED' } });
    logger.info({ type: 'automation_outreach_sent', approvalId: input.approvalId, orgId: input.orgId, draftId, messageId: result.messageId });

    return { orgId: input.orgId, sent: true, messageId: result.messageId };
  }

}

export const automationOutreachService = new AutomationOutreachService();
