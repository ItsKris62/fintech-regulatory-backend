import * as React from 'react';
import { Section, Text, Link } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EMAIL_THEME } from '../../theme';

export interface AccountRejectedEmailProps {
  userName: string;
  reason?: string;
  supportEmail: string;
}

export function AccountRejectedEmail({
  userName,
  reason,
  supportEmail,
}: AccountRejectedEmailProps) {
  return (
    <BaseLayout preheaderText="An update regarding your SheriaBot account application">
      <Text style={styles.greeting}>Hi {userName},</Text>
      <Text style={styles.body}>
        After review, we were unable to verify your SheriaBot account at this time.
      </Text>

      {reason && (
        <Section style={styles.reasonBox}>
          <Text style={styles.reasonLabel}>Reason</Text>
          <Text style={styles.reasonText}>{reason}</Text>
        </Section>
      )}

      <Text style={styles.body}>
        If you believe this is an error, please contact us at{' '}
        <Link href={`mailto:${supportEmail}`} style={styles.link}>
          {supportEmail}
        </Link>{' '}
        with your verification documents and account details.
      </Text>

      <Text style={styles.closing}>
        We appreciate your interest in SheriaBot and are happy to assist you through the
        verification process.
      </Text>
    </BaseLayout>
  );
}

export const AccountRejectedEmailSubject = 'Update on Your SheriaBot Account Application';

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
  reasonBox: {
    backgroundColor: EMAIL_THEME.colors.background,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius: '4px',
    padding: '12px 16px',
    margin: '0 0 16px',
  },
  reasonLabel: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '11px',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    margin: '0 0 6px',
  },
  reasonText: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    margin: '0',
  },
  closing: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '14px',
    lineHeight: '1.6',
    margin: '0',
  },
  link: {
    color: EMAIL_THEME.colors.primary,
    textDecoration: 'none',
  },
};
