// Auth templates
export { VerificationEmail, VerificationEmailSubject } from './templates/auth/VerificationEmail';
export type { VerificationEmailProps } from './templates/auth/VerificationEmail';

export { PasswordResetEmail, PasswordResetEmailSubject } from './templates/auth/PasswordResetEmail';
export type { PasswordResetEmailProps } from './templates/auth/PasswordResetEmail';

export { WelcomeEmail, WelcomeEmailSubject } from './templates/auth/WelcomeEmail';
export type { WelcomeEmailProps } from './templates/auth/WelcomeEmail';

// Billing templates
export { PaymentReceiptEmail, getPaymentReceiptSubject } from './templates/billing/PaymentReceiptEmail';
export type { PaymentReceiptEmailProps } from './templates/billing/PaymentReceiptEmail';

export { PaymentDueEmail, getPaymentDueSubject } from './templates/billing/PaymentDueEmail';
export type { PaymentDueEmailProps } from './templates/billing/PaymentDueEmail';

export { PaymentFailedEmail, PaymentFailedEmailSubject } from './templates/billing/PaymentFailedEmail';
export type { PaymentFailedEmailProps } from './templates/billing/PaymentFailedEmail';

export { PlanActivatedEmail, getPlanActivatedSubject } from './templates/billing/PlanActivatedEmail';
export type { PlanActivatedEmailProps } from './templates/billing/PlanActivatedEmail';

export { TrialEndingReminderEmail, getTrialEndingReminderSubject } from './templates/billing/TrialEndingReminderEmail';
export type { TrialEndingReminderEmailProps } from './templates/billing/TrialEndingReminderEmail';

export { SubscriptionCancelledEmail, getSubscriptionCancelledSubject } from './templates/billing/SubscriptionCancelledEmail';
export type { SubscriptionCancelledEmailProps } from './templates/billing/SubscriptionCancelledEmail';

export { PlanDowngradedEmail, getPlanDowngradedSubject } from './templates/billing/PlanDowngradedEmail';
export type { PlanDowngradedEmailProps } from './templates/billing/PlanDowngradedEmail';

export { EnterpriseInquiryEmail, getEnterpriseInquirySubject } from './templates/billing/EnterpriseInquiryEmail';
export type { EnterpriseInquiryEmailProps } from './templates/billing/EnterpriseInquiryEmail';

export { FreeTrialActivatedEmail, FreeTrialActivatedEmailSubject } from './templates/billing/FreeTrialActivatedEmail';
export type { FreeTrialActivatedEmailProps } from './templates/billing/FreeTrialActivatedEmail';

export { FreeTrialExpiringEmail, getFreeTrialExpiringSubject } from './templates/billing/FreeTrialExpiringEmail';
export type { FreeTrialExpiringEmailProps } from './templates/billing/FreeTrialExpiringEmail';

export { FreeTrialExpiredEmail, FreeTrialExpiredEmailSubject } from './templates/billing/FreeTrialExpiredEmail';
export type { FreeTrialExpiredEmailProps } from './templates/billing/FreeTrialExpiredEmail';

// Compliance templates
export { ComplianceQueryReadyEmail, ComplianceQueryReadyEmailSubject } from './templates/compliance/ComplianceQueryReadyEmail';
export type { ComplianceQueryReadyEmailProps } from './templates/compliance/ComplianceQueryReadyEmail';

export { PolicyDocumentReadyEmail, PolicyDocumentReadyEmailSubject } from './templates/compliance/PolicyDocumentReadyEmail';
export type { PolicyDocumentReadyEmailProps } from './templates/compliance/PolicyDocumentReadyEmail';

export { DocumentIngestionCompleteEmail, DocumentIngestionCompleteEmailSubject } from './templates/compliance/DocumentIngestionCompleteEmail';
export type { DocumentIngestionCompleteEmailProps } from './templates/compliance/DocumentIngestionCompleteEmail';

// Account templates
export { InvitationEmail, InvitationEmailSubject } from './templates/account/InvitationEmail';
export type { InvitationEmailProps } from './templates/account/InvitationEmail';

export { AccountApprovedEmail, AccountApprovedEmailSubject } from './templates/account/AccountApprovedEmail';
export type { AccountApprovedEmailProps } from './templates/account/AccountApprovedEmail';

export { AccountRejectedEmail, AccountRejectedEmailSubject } from './templates/account/AccountRejectedEmail';
export type { AccountRejectedEmailProps } from './templates/account/AccountRejectedEmail';

export { RoleChangeEmail, RoleChangeEmailSubject } from './templates/account/RoleChangeEmail';
export type { RoleChangeEmailProps } from './templates/account/RoleChangeEmail';

export { OrgVerifiedEmail, OrgVerifiedEmailSubject } from './templates/account/OrgVerifiedEmail';
export type { OrgVerifiedEmailProps } from './templates/account/OrgVerifiedEmail';

// Support templates
export { NewTicketAdminEmail, getNewTicketAdminSubject } from './templates/support/NewTicketAdminEmail';
export type { NewTicketAdminEmailProps } from './templates/support/NewTicketAdminEmail';

export { TicketConfirmationEmail, getTicketConfirmationSubject } from './templates/support/TicketConfirmationEmail';
export type { TicketConfirmationEmailProps } from './templates/support/TicketConfirmationEmail';

export { TicketStatusUpdateEmail, getTicketStatusUpdateSubject } from './templates/support/TicketStatusUpdateEmail';
export type { TicketStatusUpdateEmailProps } from './templates/support/TicketStatusUpdateEmail';

export { TicketResponseEmail, getTicketResponseSubject } from './templates/support/TicketResponseEmail';
export type { TicketResponseEmailProps } from './templates/support/TicketResponseEmail';

// Render utilities
export { renderEmailToHtml, renderEmailToText } from './render';
