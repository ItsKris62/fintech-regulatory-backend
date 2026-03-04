import * as React from 'react';
import { Section, Text, Link } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME, SUPPORT_EMAIL } from '../../theme';

export interface PaymentFailedEmailProps {
  userName: string;
  amount: string;
  planName: string;
  failureReason?: string;
  retryUrl: string;
  gracePeriodDays: number;
}

export function PaymentFailedEmail({
  userName,
  amount,
  planName,
  failureReason,
  retryUrl,
  gracePeriodDays,
}: PaymentFailedEmailProps) {
  return (
    <BaseLayout preheaderText="Your SheriaBot payment could not be processed — action required">
      <Text style={styles.greeting}>Hi {userName},</Text>

      <Section style={styles.dangerBanner}>
        <Text style={styles.dangerText}>
          &#10060; Your payment of <strong>{amount}</strong> for{' '}
          <strong>{planName}</strong> could not be processed.
        </Text>
        {failureReason && (
          <Text style={styles.dangerReason}>Reason: {failureReason}</Text>
        )}
      </Section>

      <Text style={styles.body}>
        You have <strong>{gracePeriodDays} days</strong> to update your payment method before
        your account features are restricted.
      </Text>

      <Section style={styles.ctaSection}>
        <EmailButton href={retryUrl} variant="danger">Update Payment Method</EmailButton>
      </Section>

      <Text style={styles.note}>
        If you believe this is an error, please contact our support team at{' '}
        <Link href={`mailto:${SUPPORT_EMAIL}`} style={styles.link}>
          {SUPPORT_EMAIL}
        </Link>
        .
      </Text>
    </BaseLayout>
  );
}

export const PaymentFailedEmailSubject = 'Action Required — Payment Failed for SheriaBot';

const styles: Record<string, React.CSSProperties> = {
  greeting: {
    color: EMAIL_THEME.colors.text,
    fontSize: '16px',
    fontWeight: '600',
    margin: '0 0 16px',
  },
  dangerBanner: {
    backgroundColor: EMAIL_THEME.colors.dangerBg,
    borderLeft: `4px solid ${EMAIL_THEME.colors.danger}`,
    borderRadius: '4px',
    padding: '16px',
    margin: '0 0 20px',
  },
  dangerText: {
    color: EMAIL_THEME.colors.danger,
    fontSize: '14px',
    fontWeight: '600',
    margin: '0 0 4px',
  },
  dangerReason: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    margin: '4px 0 0',
    fontStyle: 'italic',
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
  note: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    margin: '16px 0 0',
    textAlign: 'center',
  },
  link: {
    color: EMAIL_THEME.colors.primary,
    textDecoration: 'none',
  },
};
