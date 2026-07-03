import { appConfig } from '@/config/app.config';
import { sendEmail as defaultSendEmail } from '@/lib/email/client';
import type { EmailOptions, EmailResult } from '@/lib/email/client';
import { logger } from '@/utils/logger';
import type { DecisionNeeded, RankedAction } from './types';

type SendEmail = (options: EmailOptions) => Promise<EmailResult>;

export interface WeeklyBriefDeliveryDependencies {
  sendEmail?: SendEmail;
}

export interface WeeklyBriefDeliveryInput {
  subject: string;
  summary: string;
  wins: string[];
  rankedActions: RankedAction[];
  decisionsNeeded: DecisionNeeded[];
  agentRunId: string;
}

/**
 * Sibling to security-ops' own operator-alert service - same sendEmail()
 * primitive and recipient, different (weekly-brief-specific) tags. Does not
 * import from or modify anything in the security-ops module, or
 * agent-run.service.ts's own alert method.
 *
 * Unlike security-ops' evidence-gated alert, this sends on every successful
 * run unconditionally - a "nothing changed this week" brief is still the
 * point of a weekly digest.
 */
export class WeeklyBriefDeliveryService {
  private readonly sendEmail: SendEmail;

  constructor(dependencies: WeeklyBriefDeliveryDependencies = {}) {
    this.sendEmail = dependencies.sendEmail ?? defaultSendEmail;
  }

  async send(input: WeeklyBriefDeliveryInput): Promise<void> {
    const winsList = input.wins.map((win) => `<li>${win}</li>`).join('');
    const actionsList = input.rankedActions.map((item) => `<li>${item.action} (${item.sourceAgentType})</li>`).join('');
    const decisionsList = input.decisionsNeeded.map((item) => `<li>${item.decision} (${item.sourceAgentType})</li>`).join('');

    try {
      await this.sendEmail({
        to: appConfig.marketing.adminNotificationEmail,
        subject: input.subject,
        html: `<p>${input.summary}</p><h4>Wins</h4><ul>${winsList}</ul><h4>Ranked actions</h4><ul>${actionsList}</ul><h4>Decisions needed</h4><ul>${decisionsList}</ul><p>Run: ${input.agentRunId}</p>`,
        text: [
          input.summary,
          '',
          'Wins:',
          ...input.wins.map((win) => `- ${win}`),
          '',
          'Ranked actions:',
          ...input.rankedActions.map((item) => `- ${item.action} (${item.sourceAgentType})`),
          '',
          'Decisions needed:',
          ...input.decisionsNeeded.map((item) => `- ${item.decision} (${item.sourceAgentType})`),
          '',
          `Run: ${input.agentRunId}`,
        ].join('\n'),
        tags: [
          { name: 'category', value: 'operations' },
          { name: 'type', value: 'weekly_brief' },
        ],
      });
      logger.info({ type: 'chief_of_staff_brief_delivered', agentRunId: input.agentRunId });
    } catch (error: unknown) {
      logger.error({ type: 'chief_of_staff_brief_delivery_failed', agentRunId: input.agentRunId, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export const weeklyBriefDeliveryService = new WeeklyBriefDeliveryService();
