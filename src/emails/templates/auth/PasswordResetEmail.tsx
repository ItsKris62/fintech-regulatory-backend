import * as React from 'react';
import { Section, Text, Link, Hr } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME, SUPPORT_EMAIL } from '../../theme';

export interface PasswordResetEmailProps {
  userName: string;
  resetUrl: string;
  expiresInMinutes: number;
  ipAddress?: string;
}

export function PasswordResetEmail({
  userName,
  resetUrl,
  expiresInMinutes,
  ipAddress,
}: PasswordResetEmailProps) {
  return (
    <BaseLayout preheaderText="You requested a password reset for your SheriaBot account">
      <Text style={styles.greeting}>Hi {userName},</Text>
      <Text style={styles.body}>
        We received a request to reset your SheriaBot password.
      </Text>

      {ipAddress && (
        <Text style={styles.ipNote}>This request was made from IP: <strong>{ipAddress}</strong></Text>
      )}

      <Section style={styles.ctaSection}>
        <EmailButton href={resetUrl} variant="primary">Reset Password</EmailButton>
      </Section>

      <Text style={styles.expiry}>This link expires in {expiresInMinutes} minutes.</Text>

      <Hr style={styles.divider} />

      <Text style={styles.fallbackLabel}>If the button does not work, copy and paste this link:</Text>
      <Text style={styles.fallbackUrl}>
        <Link href={resetUrl} style={styles.urlLink}>
          {resetUrl}
        </Link>
      </Text>

      <Hr style={styles.divider} />

      <Section style={styles.warningBox}>
        <Text style={styles.warningText}>
          <strong>Security Notice:</strong> If you did not request a password reset, please secure
          your account immediately and contact support at{' '}
          <Link href={`mailto:${SUPPORT_EMAIL}`} style={styles.link}>
            {SUPPORT_EMAIL}
          </Link>
          .
        </Text>
      </Section>
    </BaseLayout>
  );
}

export const PasswordResetEmailSubject = 'Reset your SheriaBot password';

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
    margin: '0 0 16px',
  },
  ipNote: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    margin: '0 0 16px',
    fontStyle: 'italic',
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
  warningBox: {
    backgroundColor: EMAIL_THEME.colors.warningBg,
    borderLeft: `4px solid ${EMAIL_THEME.colors.warning}`,
    borderRadius: '4px',
    padding: '12px 16px',
  },
  warningText: {
    color: EMAIL_THEME.colors.text,
    fontSize: '13px',
    lineHeight: '1.5',
    margin: '0',
  },
  link: {
    color: EMAIL_THEME.colors.primary,
    textDecoration: 'none',
  },
};
