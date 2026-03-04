import * as React from 'react';
import { Section, Text } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface PaymentDueEmailProps {
  userName: string;
  amount: string;
  dueDate: string;
  planName: string;
  paymentUrl: string;
  daysUntilDue: number;
}

export function PaymentDueEmail({
  userName,
  amount,
  dueDate,
  planName,
  paymentUrl,
  daysUntilDue,
}: PaymentDueEmailProps) {
  const isUrgent = daysUntilDue <= 3;

  return (
    <BaseLayout
      preheaderText={`Your SheriaBot payment of ${amount} is due on ${dueDate}`}
      showUnsubscribe={true}
    >
      <Text style={styles.greeting}>Hi {userName},</Text>

      {isUrgent && (
        <Section style={styles.urgencyBanner}>
          <Text style={styles.urgencyText}>
            &#9888; Payment due in {daysUntilDue} day{daysUntilDue !== 1 ? 's' : ''}!
          </Text>
        </Section>
      )}

      <Text style={styles.body}>
        Your <strong>{planName}</strong> subscription payment of <strong>{amount}</strong> is due
        on <strong>{dueDate}</strong>.
      </Text>

      <Section style={styles.ctaSection}>
        <EmailButton href={paymentUrl}>Make Payment</EmailButton>
      </Section>

      <Text style={styles.note}>
        To avoid service interruption, please ensure payment is made by the due date.
      </Text>
    </BaseLayout>
  );
}

export function getPaymentDueSubject(planName: string): string {
  return `Payment Due — SheriaBot ${planName} Subscription`;
}

const styles: Record<string, React.CSSProperties> = {
  greeting: {
    color: EMAIL_THEME.colors.text,
    fontSize: '16px',
    fontWeight: '600',
    margin: '0 0 16px',
  },
  urgencyBanner: {
    backgroundColor: EMAIL_THEME.colors.warningBg,
    borderLeft: `4px solid ${EMAIL_THEME.colors.warning}`,
    borderRadius: '4px',
    padding: '12px 16px',
    margin: '0 0 16px',
  },
  urgencyText: {
    color: EMAIL_THEME.colors.warning,
    fontSize: '14px',
    fontWeight: '700',
    margin: '0',
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
};
