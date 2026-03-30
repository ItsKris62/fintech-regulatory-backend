import * as React from 'react';
import { Section, Text, Link, Hr } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME, SUPPORT_EMAIL } from '../../theme';

export interface PasswordChangedEmailProps {
  userName: string;
  loginUrl: string;
}

export function PasswordChangedEmail({ userName, loginUrl }: PasswordChangedEmailProps) {
  return (
    <BaseLayout preheaderText="Your SheriaBot password has been successfully changed">
      <Text style={styles.greeting}>Hi {userName},</Text>
      <Text style={styles.body}>
        Your SheriaBot password has been successfully changed.
      </Text>
      <Text style={styles.body}>
        You can now log in with your new password.
      </Text>

      <Section style={styles.ctaSection}>
        <EmailButton href={loginUrl} variant="primary">Log In</EmailButton>
      </Section>

      <Hr style={styles.divider} />

      <Section style={styles.warningBox}>
        <Text style={styles.warningText}>
          <strong>Didn't make this change?</strong> If you did not change your password,
          your account may be compromised. Please contact support immediately at{' '}
          <Link href={`mailto:${SUPPORT_EMAIL}`} style={styles.link}>
            {SUPPORT_EMAIL}
          </Link>
          .
        </Text>
      </Section>
    </BaseLayout>
  );
}

export const PasswordChangedEmailSubject = 'Your SheriaBot password has been changed';

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
  ctaSection: {
    textAlign: 'center',
    margin: '24px 0',
  },
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    margin: '24px 0',
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
