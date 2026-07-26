import { appConfig } from '@/config/app.config';
import { escapeHtml } from '@/utils/html-escape';
import { sendEmail as defaultSendEmail } from '@/lib/email/client';
import type { EmailOptions, EmailResult } from '@/lib/email/client';
import { logger } from '@/utils/logger';

type SendEmail = (options: EmailOptions) => Promise<EmailResult>;

export interface ContentOpsAlertDependencies {
  sendEmail?: SendEmail;
}

export interface ContentOpsAlertInput {
  subject: string;
  summary: string;
  details?: string[];
  link?: string;
}

/**
 * Fixed-address email alert for automation-originated content events
 * (suggestion HIGH/URGENT priority, draft ready for verification) that have
 * no real logged-in session to notify via the in-app notificationModule.
 * Deliberately decoupled from any per-monitor/per-caller "who created this"
 * attribution: same shape and same recipient config as
 * security-ops/ops-alert.service.ts's SecurityOpsAlertService.sendAlert
 * (appConfig.marketing.adminNotificationEmail) - one fixed, always-live
 * inbox, not derived per-entity, so it keeps working if a source-monitor
 * creator's account is ever deactivated or a monitor is reassigned.
 */
export class ContentOpsAlertService {
  private readonly sendEmail: SendEmail;

  constructor(dependencies: ContentOpsAlertDependencies = {}) {
    this.sendEmail = dependencies.sendEmail ?? defaultSendEmail;
  }

  async sendAlert(input: ContentOpsAlertInput): Promise<void> {
    const summaryHtml = escapeHtml(input.summary);
    const detailItems = (input.details ?? []).map((detail) => `<li>${escapeHtml(detail)}</li>`).join('');
    const linkHtml = input.link ? `<p><a href="${input.link}">Review</a></p>` : '';

    try {
      await this.sendEmail({
        to: appConfig.marketing.adminNotificationEmail,
        subject: input.subject,
        html: `<p>${summaryHtml}</p>${detailItems ? `<ul>${detailItems}</ul>` : ''}${linkHtml}`,
        text: `${input.summary}\n\n${(input.details ?? []).join('\n')}${input.link ? `\n\n${input.link}` : ''}`,
        tags: [
          { name: 'category', value: 'content' },
          { name: 'type', value: 'content_ops_alert' },
        ],
      });
      logger.info({ type: 'content_ops_alert_sent', subject: input.subject });
    } catch (error: unknown) {
      logger.error({ type: 'content_ops_alert_failed', subject: input.subject, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export const contentOpsAlertService = new ContentOpsAlertService();
