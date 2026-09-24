import * as React from 'react';
import { Section, Text, Link, Hr } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME, SHERIA_EMAIL_PALETTE, SHERIABOT_URL } from '../../theme';

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
  kraPin?: string;
  customerOrgName?: string;
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
  kraPin,
  customerOrgName,
}: PaymentReceiptEmailProps) {
  return (
    <BaseLayout
      preheaderText={`Payment of ${currency} ${amount} received — Tax Invoice #${invoiceNumber}`}
      headerBadgeText={`PAID • ${currency} ${amount}`}
    >
      <Text style={styles.greeting}>Dear {userName},</Text>
      <h1 style={styles.title}>Official Electronic Tax Receipt</h1>
      <Text style={styles.body}>
        Thank you for subscribing to SheriaBot AI Platform. This email serves as your official electronic tax invoice and confirmation of payment.
      </Text>

      {/* Structured Receipt Card */}
      <table
        border={0}
        cellPadding={0}
        cellSpacing={0}
        width="100%"
        style={styles.receiptCard}
      >
        <tbody>
          <tr>
            <td style={{ padding: '20px 24px' }}>
              <table border={0} cellPadding={0} cellSpacing={0} width="100%">
                <tbody>
                  {customerOrgName && (
                    <tr>
                      <td style={styles.metaLabel}>Billed To</td>
                      <td style={styles.metaValue}>
                        {customerOrgName} {kraPin ? `(KRA PIN: ${kraPin})` : ''}
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td style={styles.metaLabel}>Invoice Number</td>
                    <td style={styles.metaValueMono}>#{invoiceNumber}</td>
                  </tr>
                  <tr>
                    <td style={styles.metaLabel}>Payment Date</td>
                    <td style={styles.metaValue}>{paymentDate}</td>
                  </tr>
                  <tr>
                    <td style={styles.metaLabel}>Payment Channel</td>
                    <td style={styles.metaValue}>{paymentMethod}</td>
                  </tr>
                  <tr>
                    <td style={styles.metaLabel}>Subscription Tier</td>
                    <td style={styles.metaValue}>{planName}</td>
                  </tr>
                  <tr>
                    <td style={styles.metaLabel}>Billing Period</td>
                    <td style={styles.metaValue}>{billingPeriod}</td>
                  </tr>
                </tbody>
              </table>

              <Hr style={styles.receiptDivider} />

              {/* Line Items */}
              <table border={0} cellPadding={0} cellSpacing={0} width="100%">
                <tbody>
                  {items.map((item, index) => (
                    <tr key={index}>
                      <td style={styles.itemDescription}>{item.description}</td>
                      <td style={styles.itemAmount}>{item.amount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <Hr style={styles.receiptDivider} />

              {/* Total Row */}
              <table border={0} cellPadding={0} cellSpacing={0} width="100%">
                <tbody>
                  <tr>
                    <td style={styles.totalLabel}>Total Paid ({currency})</td>
                    <td style={styles.totalAmount}>
                      {currency} {amount}
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>

      {receiptUrl && (
        <Section style={styles.ctaSection}>
          <EmailButton href={receiptUrl} variant="secondary">
            📄 Download eTIMS Compliant PDF Receipt
          </EmailButton>
        </Section>
      )}

      <Text style={styles.note}>
        Questions regarding this charge or tax validation? Contact{' '}
        <Link href={`mailto:billing@sheriabot.com`} style={styles.link}>
          billing@sheriabot.com
        </Link>{' '}
        or visit our{' '}
        <Link href={`${SHERIABOT_URL}/support`} style={styles.link}>
          help center
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
    color: SHERIA_EMAIL_PALETTE.text.body,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '14px',
    fontWeight: '600',
    margin: '0 0 10px',
  },
  title: {
    color: SHERIA_EMAIL_PALETTE.text.primary,
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '18px',
    fontWeight: '700',
    margin: '0 0 12px',
  },
  body: {
    color: SHERIA_EMAIL_PALETTE.text.body,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '14px',
    lineHeight: '22px',
    margin: '0 0 20px',
  },
  receiptCard: {
    backgroundColor: SHERIA_EMAIL_PALETTE.surfaces.cardSubtle,
    border: `1px solid ${SHERIA_EMAIL_PALETTE.surfaces.borderLight}`,
    borderRadius: '6px',
    margin: '0 0 20px',
  },
  metaLabel: {
    color: SHERIA_EMAIL_PALETTE.text.muted,
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '12px',
    width: '35%',
    padding: '4px 0',
  },
  metaValue: {
    color: SHERIA_EMAIL_PALETTE.text.primary,
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '12px',
    fontWeight: '600',
    textAlign: 'right',
    padding: '4px 0',
  },
  metaValueMono: {
    color: SHERIA_EMAIL_PALETTE.brand.navy,
    fontFamily: EMAIL_THEME.fonts.citation,
    fontSize: '12px',
    fontWeight: '600',
    textAlign: 'right',
    padding: '4px 0',
  },
  receiptDivider: {
    borderColor: SHERIA_EMAIL_PALETTE.surfaces.borderLight,
    margin: '12px 0',
  },
  itemDescription: {
    color: SHERIA_EMAIL_PALETTE.text.body,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '13px',
    padding: '4px 0',
  },
  itemAmount: {
    color: SHERIA_EMAIL_PALETTE.text.primary,
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '13px',
    fontWeight: '600',
    textAlign: 'right',
    padding: '4px 0',
  },
  totalLabel: {
    color: SHERIA_EMAIL_PALETTE.text.primary,
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '14px',
    fontWeight: '700',
    padding: '6px 0 0',
  },
  totalAmount: {
    color: SHERIA_EMAIL_PALETTE.brand.primary,
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '16px',
    fontWeight: '800',
    textAlign: 'right',
    padding: '6px 0 0',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '16px 0',
  },
  note: {
    color: SHERIA_EMAIL_PALETTE.text.muted,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '12px',
    lineHeight: '18px',
    margin: '16px 0 0',
    textAlign: 'center',
  },
  link: {
    color: SHERIA_EMAIL_PALETTE.brand.primary,
    textDecoration: 'none',
    fontWeight: '600',
  },
};
