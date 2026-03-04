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

// Render utilities
export { renderEmailToHtml, renderEmailToText } from './render';
