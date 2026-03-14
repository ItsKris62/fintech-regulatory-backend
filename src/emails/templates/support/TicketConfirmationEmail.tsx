import * as React from 'react';
import { Section, Text, Hr, Row, Column } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface TicketConfirmationEmailProps {
  ticketNumber: string;
  subject: string;
  userName: string;
  category: string;
  priority: string;
}

export function TicketConfirmationEmail({
  ticketNumber,
  subject,
  userName,
  category,
  priority,
}: TicketConfirmationEmailProps) {
  const ticketUrl = `${process.env.FRONTEND_URL || 'https://sheriabot.com'}/support/${ticketNumber}`;

  return (
    <BaseLayout preheaderText={`We've received your support request: ${ticketNumber}`}>
      <Text style={styles.greeting}>Hi {userName},</Text>
      <Text style={styles.body}>
        We've received your support request and our team will review it shortly. Here's a summary
        of your ticket:
      </Text>

      <Section style={styles.detailsBox}>
        <Row style={styles.detailRow}>
          <Column style={styles.detailLabel}>Ticket Number</Column>
          <Column style={styles.ticketNumber}>{ticketNumber}</Column>
        </Row>
        <Row style={styles.detailRow}>
          <Column style={styles.detailLabel}>Subject</Column>
          <Column style={styles.detailValue}>{subject}</Column>
        </Row>
        <Row style={styles.detailRow}>
          <Column style={styles.detailLabel}>Category</Column>
          <Column style={styles.detailValue}>{category.replace(/_/g, ' ')}</Column>
        </Row>
        <Row style={styles.detailRow}>
          <Column style={styles.detailLabel}>Priority</Column>
          <Column style={styles.detailValue}>{priority}</Column>
        </Row>
      </Section>

      <Hr style={styles.divider} />

      <Text style={styles.sectionTitle}>What happens next?</Text>
      <Text style={styles.stepText}>
        <strong>1. Review</strong> — Our support team will review your request within 24 hours.
      </Text>
      <Text style={styles.stepText}>
        <strong>2. Updates</strong> — You'll receive email and in-app notifications as your ticket
        progresses.
      </Text>
      <Text style={styles.stepText}>
        <strong>3. Resolution</strong> — We'll work with you until your issue is fully resolved.
      </Text>

      <Section style={styles.ctaSection}>
        <EmailButton href={ticketUrl}>View Your Ticket</EmailButton>
      </Section>
    </BaseLayout>
  );
}

export const getTicketConfirmationSubject = (ticketNumber: string) =>
  `[SheriaBot] Ticket Received: ${ticketNumber}`;

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
  detailsBox: {
    backgroundColor: EMAIL_THEME.colors.background,
    borderRadius: '6px',
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    padding: '16px',
    marginBottom: '24px',
  },
  detailRow: {
    margin: '6px 0',
  },
  detailLabel: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    fontWeight: '600',
    width: '140px',
  },
  detailValue: {
    color: EMAIL_THEME.colors.text,
    fontSize: '13px',
  },
  ticketNumber: {
    color: EMAIL_THEME.colors.primary,
    fontSize: '13px',
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    margin: '24px 0',
  },
  sectionTitle: {
    color: EMAIL_THEME.colors.text,
    fontSize: '15px',
    fontWeight: '600',
    margin: '0 0 12px',
  },
  stepText: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    lineHeight: '1.6',
    margin: '0 0 8px',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '28px 0 0',
  },
};
