import { TRPCError } from '@trpc/server';
import { automationApprovalService as defaultAutomationApprovalService, type AutomationApprovalService } from './approval.service';

export interface SendNewsletterInput {
  approvalId: string;
  html: string;
}

export interface AutomationNewsletterServiceDependencies {
  approvalService?: AutomationApprovalService;
}

/**
 * NOT fully wired to a real send - deliberately, see the block comment on
 * sendNewsletter(). The approval gate itself is real and enforced; the actual
 * send is not, because reusing the existing campaign pipeline correctly would
 * either bypass consent/suppression enforcement or require a real product
 * decision this brief didn't make. Flagged prominently in the Phase 3 report
 * rather than silently discarding the `html` input or building a shadow send
 * path around MarketingCampaign's consent/suppression checks.
 */
export class AutomationNewsletterService {
  private readonly approvalService: AutomationApprovalService;

  constructor(dependencies: AutomationNewsletterServiceDependencies = {}) {
    this.approvalService = dependencies.approvalService ?? defaultAutomationApprovalService;
  }

  /**
   * campaign.service.ts's real send pipeline (executeSend) requires a
   * pre-existing MarketingCampaign row driven by templateKey/templateVariables
   * - there is no field anywhere on that model to hold arbitrary HTML, and its
   * 2-step requestSendConfirmation -> executeSend flow expects a live human
   * requestedById/executedById within a short confirmation window, not a
   * machine call. Building a parallel direct-send path (bypassing
   * MarketingCampaign) would also bypass the ConsentRecord/SuppressionList
   * enforcement that protects every other marketing send in this codebase -
   * queueOutreach avoids that problem only because SuppressionList is keyed
   * by raw email, not by the Contact model dependency this would still need
   * to route through, and marketing consent semantics for a broadcast
   * newsletter aren't the same question as one outreach email to an existing
   * customer contact. This needs a product decision (schema change for raw-
   * HTML campaigns? Reuse an existing template? Direct send bypassing
   * campaign tracking, accepting the consent-check gap?), not a guess.
   */
  async sendNewsletter(input: SendNewsletterInput): Promise<never> {
    const approval = await this.approvalService.getApproval({ approvalId: input.approvalId });
    if (approval.status !== 'approved') {
      throw new TRPCError({ code: 'FORBIDDEN', message: `Approval ${input.approvalId} is not approved (status: ${approval.status}).` });
    }

    throw new TRPCError({
      code: 'NOT_IMPLEMENTED',
      message: 'sendNewsletter is gated but not wired to a real send yet - MarketingCampaign has no field to hold raw HTML, and its send pipeline requires a live human confirmation step. See newsletter.service.ts for the options.',
    });
  }
}

export const automationNewsletterService = new AutomationNewsletterService();
