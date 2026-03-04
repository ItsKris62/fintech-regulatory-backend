import * as React from 'react';
import { Section, Text, Link, Hr, Row, Column } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface PaymentReceiptEmailProps {
  userName: string;
  invoiceNumber: string;
  amount: string;
  currency: string;
  paymentDate: string;
  paymentMethod: string;
  planName: string;
  billingPeriod: string;
  receiptUrl?: string;
  items: Array<{ description: string; amount: string }>;
}

export function PaymentReceiptEmail({
  userName,
  invoiceNumber,
  amount,
  currency,
  paymentDate,
  paymentMethod,
  planName,
  billingPeriod,
  receiptUrl,
  items,
}: PaymentReceiptEmailProps) {
  return (
    <BaseLayout preheaderText={`Payment of ${amount} received — Receipt #${invoiceNumber}`}>
      <Text style={styles.greeting}>Hi {userName},</Text>
      <Text style={styles.body}>
        Thank you for your payment. Here is your receipt.
      </Text>

      {/* Receipt Card */}
      <Section style={styles.receiptCard}>
        <Row>
          <Column style={styles.receiptMetaLabel}>Invoice #</Column>
          <Column style={styles.receiptMetaValue}>{invoiceNumber}</Column>
        </Row>
        <Row>
          <Column style={styles.receiptMetaLabel}>Date</Column>
          <Column style={styles.receiptMetaValue}>{paymentDate}</Column>
        </Row>
        <Row>
          <Column style={styles.receiptMetaLabel}>Payment Method</Column>
          <Column style={styles.receiptMetaValue}>{paymentMethod}</Column>
        </Row>
        <Row>
          <Column style={styles.receiptMetaLabel}>Plan</Column>
          <Column style={styles.receiptMetaValue}>{planName}</Column>
        </Row>
        <Row>
          <Column style={styles.receiptMetaLabel}>Billing Period</Column>
          <Column style={styles.receiptMetaValue}>{billingPeriod}</Column>
        </Row>

        <Hr style={styles.receiptDivider} />

        {/* Line Items */}
        {items.map((item, index) => (
          <Row key={index}>
            <Column style={styles.itemDescription}>{item.description}</Column>
            <Column style={styles.itemAmount}>{item.amount}</Column>
          </Row>
        ))}

        <Hr style={styles.receiptDivider} />

        {/* Total */}
        <Row>
          <Column style={styles.totalLabel}>Total ({currency})</Column>
          <Column style={styles.totalAmount}>{amount}</Column>
        </Row>
      </Section>

      {receiptUrl && (
        <Section style={styles.ctaSection}>
          <EmailButton href={receiptUrl} variant="secondary">
            Download PDF Receipt
          </EmailButton>
        </Section>
      )}

      <Text style={styles.note}>
        Questions about this charge? Reply to this email or contact our{' '}
        <Link href={`${process.env.FRONTEND_URL || 'https://sheriabot.com'}/support`} style={styles.link}>
          support team
        </Link>
        .
      </Text>
    </BaseLayout>
  );
}

export function getPaymentReceiptSubject(amount: string, invoiceNumber: string): string {
  return `Payment Receipt — SheriaBot #${invoiceNumber} (${amount})`;
}

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
    margin: '0 0 20px',
  },
  receiptCard: {
    backgroundColor: EMAIL_THEME.colors.background,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius: '6px',
    padding: '20px',
    margin: '0 0 20px',
  },
  receiptMetaLabel: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    width: '40%',
    padding: '4px 0',
  },
  receiptMetaValue: {
    color: EMAIL_THEME.colors.text,
    fontSize: '13px',
    fontWeight: '500',
    padding: '4px 0',
  },
  receiptDivider: {
    borderColor: EMAIL_THEME.colors.border,
    margin: '12px 0',
  },
  itemDescription: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    width: '70%',
    padding: '4px 0',
  },
  itemAmount: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    textAlign: 'right',
    padding: '4px 0',
  },
  totalLabel: {
    color: EMAIL_THEME.colors.text,
    fontSize: '15px',
    fontWeight: '700',
    width: '70%',
    padding: '4px 0',
  },
  totalAmount: {
    color: EMAIL_THEME.colors.primary,
    fontSize: '15px',
    fontWeight: '700',
    textAlign: 'right',
    padding: '4px 0',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '20px 0',
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
