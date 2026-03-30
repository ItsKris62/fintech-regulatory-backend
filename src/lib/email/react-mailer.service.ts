/**
 * React Email Mailer Service
 *
 * Extends the existing email client with typed send methods for all
 * React Email templates. Each method:
 *   1. Checks notification preferences (for toggleable emails)
 *   2. Renders the React Email template to HTML
 *   3. Sends via Resend (using the existing sendEmail client)
 *   4. Logs the attempt
 *   5. Handles errors gracefully — email failures never crash the app
 */

import * as React from 'react';
import { sendEmail } from './client';
import { renderEmailToHtml, renderEmailToText } from '@/emails/render';
import { logger } from '@/utils/logger';
import { prisma } from '@/lib/prisma/client';

// ─── Template Imports ────────────────────────────────────────────────────────

import {
  NewTicketAdminEmail,
  getNewTicketAdminSubject,
  TicketConfirmationEmail,
  getTicketConfirmationSubject,
  TicketStatusUpdateEmail,
  getTicketStatusUpdateSubject,
  TicketResponseEmail,
  getTicketResponseSubject,
  VerificationEmail,
  VerificationEmailSubject,
  PasswordResetEmail,
  PasswordResetEmailSubject,
  PasswordChangedEmail,
  PasswordChangedEmailSubject,
  WelcomeEmail,
  WelcomeEmailSubject,
  PaymentReceiptEmail,
  getPaymentReceiptSubject,
  PaymentDueEmail,
  getPaymentDueSubject,
  PaymentFailedEmail,
  PaymentFailedEmailSubject,
  PlanActivatedEmail,
  getPlanActivatedSubject,
  TrialEndingReminderEmail,
  getTrialEndingReminderSubject,
  SubscriptionCancelledEmail,
  getSubscriptionCancelledSubject,
  PlanDowngradedEmail,
  getPlanDowngradedSubject,
  ComplianceQueryReadyEmail,
  ComplianceQueryReadyEmailSubject,
  PolicyDocumentReadyEmail,
  PolicyDocumentReadyEmailSubject,
  DocumentIngestionCompleteEmail,
  DocumentIngestionCompleteEmailSubject,
  InvitationEmail,
  InvitationEmailSubject,
  AccountApprovedEmail,
  AccountApprovedEmailSubject,
  AccountRejectedEmail,
  AccountRejectedEmailSubject,
  RoleChangeEmail,
  RoleChangeEmailSubject,
  OrgVerifiedEmail,
  OrgVerifiedEmailSubject,
  EnterpriseInquiryEmail,
  getEnterpriseInquirySubject,
  FreeTrialActivatedEmail,
  FreeTrialActivatedEmailSubject,
  FreeTrialExpiringEmail,
  getFreeTrialExpiringSubject,
  FreeTrialExpiredEmail,
  FreeTrialExpiredEmailSubject,
} from '@/emails';

import type {
  NewTicketAdminEmailProps,
  TicketConfirmationEmailProps,
  TicketStatusUpdateEmailProps,
  TicketResponseEmailProps,
  VerificationEmailProps,
  PasswordResetEmailProps,
  PasswordChangedEmailProps,
  WelcomeEmailProps,
  PaymentReceiptEmailProps,
  PaymentDueEmailProps,
  PaymentFailedEmailProps,
  PlanActivatedEmailProps,
  TrialEndingReminderEmailProps,
  SubscriptionCancelledEmailProps,
  PlanDowngradedEmailProps,
  ComplianceQueryReadyEmailProps,
  PolicyDocumentReadyEmailProps,
  DocumentIngestionCompleteEmailProps,
  InvitationEmailProps,
  AccountApprovedEmailProps,
  AccountRejectedEmailProps,
  RoleChangeEmailProps,
  OrgVerifiedEmailProps,
  EnterpriseInquiryEmailProps,
  FreeTrialActivatedEmailProps,
  FreeTrialExpiringEmailProps,
  FreeTrialExpiredEmailProps,
} from '@/emails';

// ─── Notification Preference Keys ────────────────────────────────────────────

type ToggleableNotificationType =
  | 'paymentDueReminder'
  | 'complianceQueryReady'
  | 'policyDocumentReady'
  | 'documentIngestionComplete';

/**
 * Check whether a user has enabled a specific toggleable notification type.
 * Defaults to true if the preference record doesn't exist yet.
 */
async function shouldSendNotification(
  userId: string,
  notificationType: ToggleableNotificationType
): Promise<boolean> {
  try {
    const prefs = await prisma.notificationPreference.findUnique({
      where: { userId },
      select: { [notificationType]: true },
    });

    if (!prefs) return true; // Default to enabled if no preferences set

    return (prefs as Record<string, boolean>)[notificationType] ?? true;
  } catch (error: any) {
    logger.warn({
      type: 'notification_preference_check_failed',
      userId,
      notificationType,
      error: error.message,
    });
    return true; // Fail open
  }
}

// ─── Helper ──────────────────────────────────────────────────────────────────

async function sendReactEmail(opts: {
  to: string;
  subject: string;
  element: React.ReactElement;
  tags?: Array<{ name: string; value: string }>;
  logType: string;
}): Promise<void> {
  try {
    const [html, text] = await Promise.all([
      renderEmailToHtml(opts.element),
      renderEmailToText(opts.element),
    ]);

    const result = await sendEmail({
      to: opts.to,
      subject: opts.subject,
      html,
      text,
      tags: opts.tags,
    });

    if (!result.success) {
      logger.error({
        type: `${opts.logType}_failed`,
        to: opts.to,
        error: result.error,
      });
    }
  } catch (error: any) {
    // Email failures must never crash the application
    logger.error({
      type: `${opts.logType}_error`,
      to: opts.to,
      error: error.message,
    });
  }
}

// ─── React Email Mailer ───────────────────────────────────────────────────────

class ReactMailerService {
  // ── AUTH EMAILS (always sent, no preference check) ──

  async sendVerificationEmail(to: string, props: VerificationEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: VerificationEmailSubject,
      element: React.createElement(VerificationEmail, props),
      tags: [{ name: 'category', value: 'auth' }, { name: 'type', value: 'verification' }],
      logType: 'verification_email',
    });
  }

  async sendPasswordResetEmail(to: string, props: PasswordResetEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: PasswordResetEmailSubject,
      element: React.createElement(PasswordResetEmail, props),
      tags: [{ name: 'category', value: 'auth' }, { name: 'type', value: 'password_reset' }],
      logType: 'password_reset_email',
    });
  }

  async sendPasswordChangedEmail(to: string, props: PasswordChangedEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: PasswordChangedEmailSubject,
      element: React.createElement(PasswordChangedEmail, props),
      tags: [{ name: 'category', value: 'auth' }, { name: 'type', value: 'password_changed' }],
      logType: 'password_changed_email',
    });
  }

  async sendWelcomeEmail(to: string, props: WelcomeEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: WelcomeEmailSubject,
      element: React.createElement(WelcomeEmail, props),
      tags: [{ name: 'category', value: 'auth' }, { name: 'type', value: 'welcome' }],
      logType: 'welcome_email',
    });
  }

  // ── BILLING EMAILS ──

  /** Mandatory — always sent */
  async sendPaymentReceiptEmail(to: string, props: PaymentReceiptEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: getPaymentReceiptSubject(props.amount, props.invoiceNumber),
      element: React.createElement(PaymentReceiptEmail, props),
      tags: [{ name: 'category', value: 'billing' }, { name: 'type', value: 'receipt' }],
      logType: 'payment_receipt_email',
    });
  }

  /** Toggleable */
  async sendPaymentDueEmail(to: string, userId: string, props: PaymentDueEmailProps): Promise<void> {
    const enabled = await shouldSendNotification(userId, 'paymentDueReminder');
    if (!enabled) return;

    await sendReactEmail({
      to,
      subject: getPaymentDueSubject(props.planName),
      element: React.createElement(PaymentDueEmail, props),
      tags: [{ name: 'category', value: 'billing' }, { name: 'type', value: 'payment_due' }],
      logType: 'payment_due_email',
    });
  }

  /** Mandatory */
  async sendPaymentFailedEmail(to: string, props: PaymentFailedEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: PaymentFailedEmailSubject,
      element: React.createElement(PaymentFailedEmail, props),
      tags: [{ name: 'category', value: 'billing' }, { name: 'type', value: 'payment_failed' }],
      logType: 'payment_failed_email',
    });
  }

  /** Mandatory — sent on checkout completion (trial start or direct subscription) */
  async sendPlanActivatedEmail(to: string, props: PlanActivatedEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: getPlanActivatedSubject(props.planName, Boolean(props.trialEndsAt)),
      element: React.createElement(PlanActivatedEmail, props),
      tags: [{ name: 'category', value: 'billing' }, { name: 'type', value: 'plan_activated' }],
      logType: 'plan_activated_email',
    });
  }

  /** Mandatory — sent when Stripe fires customer.subscription.trial_will_end */
  async sendTrialEndingReminderEmail(to: string, props: TrialEndingReminderEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: getTrialEndingReminderSubject(props.planName, props.daysRemaining),
      element: React.createElement(TrialEndingReminderEmail, props),
      tags: [{ name: 'category', value: 'billing' }, { name: 'type', value: 'trial_ending' }],
      logType: 'trial_ending_reminder_email',
    });
  }

  /** Mandatory — sent on subscription cancellation (grace period begins) */
  async sendSubscriptionCancelledEmail(to: string, props: SubscriptionCancelledEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: getSubscriptionCancelledSubject(props.planName),
      element: React.createElement(SubscriptionCancelledEmail, props),
      tags: [{ name: 'category', value: 'billing' }, { name: 'type', value: 'subscription_cancelled' }],
      logType: 'subscription_cancelled_email',
    });
  }

  /** Mandatory — sent when grace period expires and plan is downgraded to free */
  async sendPlanDowngradedEmail(to: string, props: PlanDowngradedEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: getPlanDowngradedSubject(props.previousPlanName),
      element: React.createElement(PlanDowngradedEmail, props),
      tags: [{ name: 'category', value: 'billing' }, { name: 'type', value: 'plan_downgraded' }],
      logType: 'plan_downgraded_email',
    });
  }

  // ── COMPLIANCE EMAILS (toggleable) ──

  async sendComplianceQueryReadyEmail(
    to: string,
    userId: string,
    props: ComplianceQueryReadyEmailProps
  ): Promise<void> {
    const enabled = await shouldSendNotification(userId, 'complianceQueryReady');
    if (!enabled) return;

    await sendReactEmail({
      to,
      subject: ComplianceQueryReadyEmailSubject,
      element: React.createElement(ComplianceQueryReadyEmail, props),
      tags: [{ name: 'category', value: 'compliance' }, { name: 'type', value: 'query_ready' }],
      logType: 'compliance_query_ready_email',
    });
  }

  async sendPolicyDocumentReadyEmail(
    to: string,
    userId: string,
    props: PolicyDocumentReadyEmailProps
  ): Promise<void> {
    const enabled = await shouldSendNotification(userId, 'policyDocumentReady');
    if (!enabled) return;

    await sendReactEmail({
      to,
      subject: PolicyDocumentReadyEmailSubject,
      element: React.createElement(PolicyDocumentReadyEmail, props),
      tags: [{ name: 'category', value: 'compliance' }, { name: 'type', value: 'policy_ready' }],
      logType: 'policy_document_ready_email',
    });
  }

  async sendDocumentIngestionCompleteEmail(
    to: string,
    userId: string,
    props: DocumentIngestionCompleteEmailProps
  ): Promise<void> {
    const enabled = await shouldSendNotification(userId, 'documentIngestionComplete');
    if (!enabled) return;

    await sendReactEmail({
      to,
      subject: DocumentIngestionCompleteEmailSubject,
      element: React.createElement(DocumentIngestionCompleteEmail, props),
      tags: [{ name: 'category', value: 'compliance' }, { name: 'type', value: 'doc_ingested' }],
      logType: 'document_ingestion_complete_email',
    });
  }

  // ── ACCOUNT EMAILS (mandatory) ──

  async sendInvitationEmail(to: string, props: InvitationEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: InvitationEmailSubject,
      element: React.createElement(InvitationEmail, props),
      tags: [{ name: 'category', value: 'account' }, { name: 'type', value: 'invitation' }],
      logType: 'invitation_email',
    });
  }

  async sendAccountApprovedEmail(to: string, props: AccountApprovedEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: AccountApprovedEmailSubject,
      element: React.createElement(AccountApprovedEmail, props),
      tags: [{ name: 'category', value: 'account' }, { name: 'type', value: 'approved' }],
      logType: 'account_approved_email',
    });
  }

  async sendAccountRejectedEmail(to: string, props: AccountRejectedEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: AccountRejectedEmailSubject,
      element: React.createElement(AccountRejectedEmail, props),
      tags: [{ name: 'category', value: 'account' }, { name: 'type', value: 'rejected' }],
      logType: 'account_rejected_email',
    });
  }

  async sendRoleChangeEmail(to: string, props: RoleChangeEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: RoleChangeEmailSubject,
      element: React.createElement(RoleChangeEmail, props),
      tags: [{ name: 'category', value: 'account' }, { name: 'type', value: 'role_change' }],
      logType: 'role_change_email',
    });
  }

  async sendOrgVerifiedEmail(to: string, props: OrgVerifiedEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: OrgVerifiedEmailSubject,
      element: React.createElement(OrgVerifiedEmail, props),
      tags: [{ name: 'category', value: 'account' }, { name: 'type', value: 'org_verified' }],
      logType: 'org_verified_email',
    });
  }

  // ── SUPPORT TICKET EMAILS (mandatory — always sent) ──

  async sendNewTicketAdminEmail(to: string, props: NewTicketAdminEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: getNewTicketAdminSubject(props.ticketNumber, props.subject),
      element: React.createElement(NewTicketAdminEmail, props),
      tags: [{ name: 'category', value: 'support' }, { name: 'type', value: 'new_ticket_admin' }],
      logType: 'new_ticket_admin_email',
    });
  }

  async sendTicketConfirmationEmail(to: string, props: TicketConfirmationEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: getTicketConfirmationSubject(props.ticketNumber),
      element: React.createElement(TicketConfirmationEmail, props),
      tags: [{ name: 'category', value: 'support' }, { name: 'type', value: 'ticket_confirmation' }],
      logType: 'ticket_confirmation_email',
    });
  }

  async sendTicketStatusUpdateEmail(to: string, props: TicketStatusUpdateEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: getTicketStatusUpdateSubject(props.ticketNumber, props.newStatus),
      element: React.createElement(TicketStatusUpdateEmail, props),
      tags: [{ name: 'category', value: 'support' }, { name: 'type', value: 'ticket_status_update' }],
      logType: 'ticket_status_update_email',
    });
  }

  async sendTicketResponseEmail(to: string, props: TicketResponseEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: getTicketResponseSubject(props.ticketNumber),
      element: React.createElement(TicketResponseEmail, props),
      tags: [{ name: 'category', value: 'support' }, { name: 'type', value: 'ticket_response' }],
      logType: 'ticket_response_email',
    });
  }

  // ── ENTERPRISE INQUIRY EMAIL (sent to admin) ──

  /** Sent to the SheriaBot admin inbox when an org submits an Enterprise inquiry. */
  async sendEnterpriseInquiryEmail(to: string, props: EnterpriseInquiryEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: getEnterpriseInquirySubject(props.orgName),
      element: React.createElement(EnterpriseInquiryEmail, props),
      tags: [{ name: 'category', value: 'billing' }, { name: 'type', value: 'enterprise_inquiry' }],
      logType: 'enterprise_inquiry_email',
    });
  }

  // ── FREE TRIAL EMAILS (always sent, user-scoped) ──

  /** Sent immediately when a user activates their 7-day free trial. */
  async sendFreeTrialActivatedEmail(to: string, props: FreeTrialActivatedEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: FreeTrialActivatedEmailSubject,
      element: React.createElement(FreeTrialActivatedEmail, props),
      tags: [{ name: 'category', value: 'trial' }, { name: 'type', value: 'trial_activated' }],
      logType: 'free_trial_activated_email',
    });
  }

  /** Sent lazily when ≤ 2 days remain in the free trial (idempotent via Redis sentinel). */
  async sendFreeTrialExpiringEmail(to: string, props: FreeTrialExpiringEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: getFreeTrialExpiringSubject(props.daysRemaining),
      element: React.createElement(FreeTrialExpiringEmail, props),
      tags: [{ name: 'category', value: 'trial' }, { name: 'type', value: 'trial_expiring' }],
      logType: 'free_trial_expiring_email',
    });
  }

  /** Sent lazily after the free trial expires (idempotent via Redis sentinel). */
  async sendFreeTrialExpiredEmail(to: string, props: FreeTrialExpiredEmailProps): Promise<void> {
    await sendReactEmail({
      to,
      subject: FreeTrialExpiredEmailSubject,
      element: React.createElement(FreeTrialExpiredEmail, props),
      tags: [{ name: 'category', value: 'trial' }, { name: 'type', value: 'trial_expired' }],
      logType: 'free_trial_expired_email',
    });
  }
}

export const reactMailer = new ReactMailerService();
export { ReactMailerService };
