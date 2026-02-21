import { sendEmail, queueEmail, EmailOptions } from './client';
import { generateWelcomeEmail, WelcomeEmailParams } from './templates/welcome';
import { generatePasswordResetEmail, PasswordResetEmailParams } from './templates/password-reset';
import { generatePolicyReadyEmail, PolicyReadyEmailParams } from './templates/policy-ready';
import { generateComplianceAlertEmail, ComplianceAlertEmailParams } from './templates/compliance-alert';
import { logger } from '@/utils/logger';
import { appConfig } from '@/config/app.config';

/**
 * High-level mailer service
 * Integrates email templates with sending logic
 */
export class MailerService {
  /**
   * Send welcome email with verification link
   * @param params Welcome email parameters
   * @param immediate Send immediately or queue (default: immediate)
   */
  async sendWelcomeEmail(
    params: WelcomeEmailParams,
    immediate: boolean = true
  ): Promise<void> {
    const { html, text, subject } = generateWelcomeEmail(params);

    const options: EmailOptions = {
      to: params.email,
      subject,
      html,
      text,
      tags: [
        { name: 'category', value: 'authentication' },
        { name: 'type', value: 'welcome' },
      ],
    };

    if (immediate) {
      const result = await sendEmail(options);
      
      if (!result.success) {
        logger.error({
          type: 'welcome_email_failed',
          email: params.email,
          error: result.error,
        });
        // Queue for retry
        await queueEmail(options, 10);
      }
    } else {
      await queueEmail(options, 10);
    }

    logger.info({
      type: 'welcome_email_sent',
      email: params.email,
      immediate,
    });
  }

  /**
   * Send password reset email
   * @param params Password reset email parameters
   */
  async sendPasswordResetEmail(params: PasswordResetEmailParams): Promise<void> {
    const { html, text, subject } = generatePasswordResetEmail(params);

    const options: EmailOptions = {
      to: params.email,
      subject,
      html,
      text,
      tags: [
        { name: 'category', value: 'authentication' },
        { name: 'type', value: 'password_reset' },
      ],
    };

    // Password resets are critical - always send immediately
    const result = await sendEmail(options);

    if (!result.success) {
      logger.error({
        type: 'password_reset_email_failed',
        email: params.email,
        error: result.error,
      });
      // Queue for immediate retry with high priority
      await queueEmail(options, 100);
      throw new Error('Failed to send password reset email');
    }

    logger.info({
      type: 'password_reset_email_sent',
      email: params.email,
    });
  }

  /**
   * Send policy ready notification email
   * @param params Policy ready email parameters
   * @param immediate Send immediately or queue (default: queue)
   */
  async sendPolicyReadyEmail(
    params: PolicyReadyEmailParams,
    immediate: boolean = false
  ): Promise<void> {
    const { html, text, subject } = generatePolicyReadyEmail(params);

    // Get user email from database if not provided
    // This is a placeholder - you'll implement this based on your user lookup
    const userEmail = await this.getUserEmail(params.name);

    const options: EmailOptions = {
      to: userEmail,
      subject,
      html,
      text,
      tags: [
        { name: 'category', value: 'notification' },
        { name: 'type', value: 'policy_ready' },
      ],
    };

    if (immediate) {
      const result = await sendEmail(options);
      
      if (!result.success) {
        logger.warn({
          type: 'policy_ready_email_failed',
          policyId: params.policyId,
          error: result.error,
        });
        await queueEmail(options, 5);
      }
    } else {
      await queueEmail(options, 5);
    }

    logger.info({
      type: 'policy_ready_email_sent',
      policyId: params.policyId,
      immediate,
    });
  }

  /**
   * Send compliance alert email
   * @param params Compliance alert email parameters
   */
  async sendComplianceAlertEmail(params: ComplianceAlertEmailParams): Promise<void> {
    const { html, text, subject } = generateComplianceAlertEmail(params);

    // Get user email from database if not provided
    const userEmail = await this.getUserEmail(params.name);

    const options: EmailOptions = {
      to: userEmail,
      subject,
      html,
      text,
      tags: [
        { name: 'category', value: 'notification' },
        { name: 'type', value: 'compliance_alert' },
        { name: 'severity', value: params.severity.toLowerCase() },
      ],
    };

    // Critical alerts sent immediately
    if (params.severity === 'CRITICAL' || params.severity === 'HIGH') {
      const result = await sendEmail(options);
      
      if (!result.success) {
        logger.error({
          type: 'compliance_alert_email_failed',
          severity: params.severity,
          error: result.error,
        });
        await queueEmail(options, 50);
      }
    } else {
      await queueEmail(options, 3);
    }

    logger.info({
      type: 'compliance_alert_email_sent',
      severity: params.severity,
    });
  }

  /**
   * Send generic notification email
   * @param to Recipient email
   * @param subject Email subject
   * @param message Email message (plain text)
   * @param htmlMessage Optional HTML message
   */
  async sendNotificationEmail(
    to: string,
    subject: string,
    message: string,
    htmlMessage?: string
  ): Promise<void> {
    const html = htmlMessage || this.wrapInTemplate(message);

    const options: EmailOptions = {
      to,
      subject,
      html,
      text: message,
      tags: [
        { name: 'category', value: 'notification' },
        { name: 'type', value: 'generic' },
      ],
    };

    await queueEmail(options, 1);

    logger.info({
      type: 'notification_email_queued',
      to,
    });
  }

  /**
   * Send email to multiple recipients
   * @param recipients Array of email addresses
   * @param subject Email subject
   * @param html HTML content
   * @param text Plain text content
   */
  async sendBulkEmail(
    recipients: string[],
    subject: string,
    html: string,
    text?: string
  ): Promise<void> {
    // Split into batches to avoid overwhelming the email service
    const batchSize = 50;
    
    for (let i = 0; i < recipients.length; i += batchSize) {
      const batch = recipients.slice(i, i + batchSize);

      const options: EmailOptions = {
        to: batch,
        subject,
        html,
        text,
        tags: [
          { name: 'category', value: 'bulk' },
        ],
      };

      await queueEmail(options, 0);
    }

    logger.info({
      type: 'bulk_email_queued',
      recipientCount: recipients.length,
    });
  }

  /**
   * Wrap plain text in simple HTML template
   * @param message Plain text message
   * @returns HTML wrapped message
   */
  private wrapInTemplate(message: string): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
    }
    .container {
      background-color: #ffffff;
      border-radius: 8px;
      padding: 30px;
    }
    .header {
      text-align: center;
      margin-bottom: 30px;
    }
    .logo {
      font-size: 28px;
      font-weight: bold;
      color: #10B981;
    }
    .footer {
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #e0e0e0;
      text-align: center;
      color: #888;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">SheriaBot</div>
    </div>
    <div>
      ${message.replace(/\n/g, '<br>')}
    </div>
    <div class="footer">
      <p>© 2024 SheriaBot. AI-Powered Regulatory Compliance for Kenya.</p>
    </div>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Get user email from database
   * Placeholder - implement based on your user lookup logic
   * @param nameOrId User name or ID
   * @returns User email
   */
  private async getUserEmail(nameOrId: string): Promise<string> {
    // TODO: Implement actual user lookup from database
    // For now, return a placeholder
    // In production, you would:
    // const user = await prisma.user.findFirst({ where: { name: nameOrId } });
    // return user.email;
    
    logger.warn({
      type: 'getUserEmail_not_implemented',
      nameOrId,
    });
    
    return 'user@example.com'; // Placeholder
  }
}

/**
 * Export singleton mailer service instance
 */
export const mailer = new MailerService();

/**
 * Email service helper functions
 */

/**
 * Send test email (development only)
 * @param to Recipient email
 */
export async function sendTestEmail(to: string): Promise<void> {
  if (appConfig.isProduction) {
    logger.warn('Test emails disabled in production');
    return;
  }

  await sendEmail({
    to,
    subject: 'SheriaBot Test Email',
    html: '<h1>Test Email</h1><p>This is a test email from SheriaBot.</p>',
    text: 'Test Email\n\nThis is a test email from SheriaBot.',
  });

  logger.info({
    type: 'test_email_sent',
    to,
  });
}

/**
 * Send verification email
 * Convenience wrapper for welcome email
 */
export async function sendVerificationEmail(
  email: string,
  name: string,
  verificationToken: string,
  role: string
): Promise<void> {
  const verificationUrl = `${appConfig.frontendUrl}/verify-email?token=${verificationToken}`;

  await mailer.sendWelcomeEmail({
    email,
    name,
    verificationUrl,
    role,
  });
}

/**
 * Send password reset
 * Convenience wrapper for password reset email
 */
export async function sendPasswordReset(
  email: string,
  name: string,
  resetToken: string,
  expiresIn: string = '1 hour'
): Promise<void> {
  const resetUrl = `${appConfig.frontendUrl}/reset-password?token=${resetToken}`;

  await mailer.sendPasswordResetEmail({
    email,
    name,
    resetUrl,
    expiresIn,
  });
}