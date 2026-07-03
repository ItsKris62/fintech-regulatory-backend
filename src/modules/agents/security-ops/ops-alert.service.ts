import { appConfig } from '@/config/app.config';
import { sendEmail as defaultSendEmail } from '@/lib/email/client';
import type { EmailOptions, EmailResult } from '@/lib/email/client';
import { logger } from '@/utils/logger';

type SendEmail = (options: EmailOptions) => Promise<EmailResult>;

export interface OpsAlertDependencies {
  sendEmail?: SendEmail;
}

export interface OpsAlertInput {
  subject: string;
  summary: string;
  risks: string[];
  agentRunId: string;
}

/**
 * Sibling to agent-run.service.ts's own private operator-alert method - same
 * sendEmail() primitive and recipient, different (ops-specific) tags. Does not import
 * from or modify src/modules/agents/agent-run.service.ts.
 */
export class SecurityOpsAlertService {
  private readonly sendEmail: SendEmail;

  constructor(dependencies: OpsAlertDependencies = {}) {
    this.sendEmail = dependencies.sendEmail ?? defaultSendEmail;
  }

  async sendAlert(input: OpsAlertInput): Promise<void> {
    const riskLines = input.risks.map((risk) => `<li>${risk}</li>`).join('');
    try {
      await this.sendEmail({
        to: appConfig.marketing.adminNotificationEmail,
        subject: input.subject,
        html: `<p>${input.summary}</p><ul>${riskLines}</ul><p>Run: ${input.agentRunId}</p>`,
        text: `${input.summary}\n\n${input.risks.join('\n')}\n\nRun: ${input.agentRunId}`,
        tags: [
          { name: 'category', value: 'security' },
          { name: 'type', value: 'security_ops_alert' },
        ],
      });
      logger.info({ type: 'security_ops_alert_sent', agentRunId: input.agentRunId });
    } catch (error: unknown) {
      logger.error({ type: 'security_ops_alert_failed', agentRunId: input.agentRunId, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export const securityOpsAlertService = new SecurityOpsAlertService();
