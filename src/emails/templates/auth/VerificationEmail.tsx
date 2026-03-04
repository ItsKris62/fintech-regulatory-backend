import * as React from 'react';
import { Section, Text, Link, Hr } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME, SUPPORT_EMAIL } from '../../theme';

export interface VerificationEmailProps {
  userName: string;
  verificationUrl: string;
  expiresInHours: number;
}

export function VerificationEmail({
  userName,
  verificationUrl,
  expiresInHours,
}: VerificationEmailProps) {
  return (
    <BaseLayout preheaderText="Please verify your email address to activate your SheriaBot account">
      <Text style={styles.greeting}>Hi {userName},</Text>
      <Text style={styles.body}>
        Thank you for creating your SheriaBot account. To get started, please verify your email
        address by clicking the button below.
      </Text>

      <Section style={styles.ctaSection}>
        <EmailButton href={verificationUrl}>Verify Email Address</EmailButton>
      </Section>

      <Text style={styles.expiry}>This link expires in {expiresInHours} hours.</Text>

      <Hr style={styles.divider} />

      <Text style={styles.fallbackLabel}>If the button does not work, copy and paste this link:</Text>
      <Text style={styles.fallbackUrl}>
        <Link href={verificationUrl} style={styles.urlLink}>
          {verificationUrl}
        </Link>
      </Text>

      <Hr style={styles.divider} />

      <Text style={styles.securityNote}>
        If you did not create a SheriaBot account, you can safely ignore this email.
        Contact us at{' '}
        <Link href={`mailto:${SUPPORT_EMAIL}`} style={styles.link}>
          {SUPPORT_EMAIL}
        </Link>{' '}
        if you have concerns.
      </Text>
    </BaseLayout>
  );
}

export const VerificationEmailSubject = 'Verify your email to get started with SheriaBot';

const styles: Record<string, React.CSSProperties> = {
  greeting: {
    color: EMAIL_THEME.colors.text,
    fontSize: '16px',
    fontWeight: '600',
    margin: '0 0 16px',
  },
  body: {
    color: EMAIL_THEME.colors.text,
    fontSize: '15px',
    lineHeight: '1.6',
    margin: '0 0 24px',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '24px 0',
  },
  expiry: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    textAlign: 'center',
    margin: '12px 0 0',
  },
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    margin: '24px 0',
  },
  fallbackLabel: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    margin: '0 0 8px',
  },
  fallbackUrl: {
    color: EMAIL_THEME.colors.textMuted,
    fontSize: '12px',
    wordBreak: 'break-all',
    margin: '0',
  },
  urlLink: {
    color: EMAIL_THEME.colors.primaryLight,
    textDecoration: 'underline',
  },
  securityNote: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    lineHeight: '1.5',
    margin: '0',
  },
  link: {
    color: EMAIL_THEME.colors.primary,
    textDecoration: 'none',
  },
};
