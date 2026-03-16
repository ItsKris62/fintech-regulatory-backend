import * as React from 'react';
import { Section, Text, Hr, Row, Column } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EMAIL_THEME } from '../../theme';

export interface EnterpriseInquiryEmailProps {
  /** Name of the person submitting the inquiry */
  contactName: string;
  /** Email of the person submitting the inquiry */
  contactEmail: string;
  /** Organization name */
  orgName: string;
  /** Current subscription plan of the org */
  currentPlan: string;
  /** Optional message from the contact */
  message?: string;
  /** ISO timestamp of when the inquiry was submitted */
  submittedAt: string;
}

export function getEnterpriseInquirySubject(orgName: string): string {
  return `Enterprise Inquiry: ${orgName}`;
}

export function EnterpriseInquiryEmail({
  contactName,
  contactEmail,
  orgName,
  currentPlan,
  message,
  submittedAt,
}: EnterpriseInquiryEmailProps) {
  const submittedDate = new Date(submittedAt).toLocaleString('en-KE', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Nairobi',
  });

  return (
    <BaseLayout preheaderText={`New Enterprise plan inquiry from ${orgName}`}>
      <Text style={styles.heading}>New Enterprise Plan Inquiry</Text>

      <Text style={styles.body}>
        A new Enterprise plan inquiry has been submitted via the SheriaBot billing portal.
        Please follow up with the contact within 24 hours.
      </Text>

      <Section style={styles.infoCard}>
        <Text style={styles.cardHeading}>Contact Details</Text>
        <Hr style={styles.divider} />

        <Row style={styles.row}>
          <Column style={styles.label}>Name</Column>
          <Column style={styles.value}>{contactName}</Column>
        </Row>
        <Row style={styles.row}>
          <Column style={styles.label}>Email</Column>
          <Column style={styles.valueLink}>
            <a href={`mailto:${contactEmail}`} style={styles.link}>{contactEmail}</a>
          </Column>
        </Row>
        <Row style={styles.row}>
          <Column style={styles.label}>Organization</Column>
          <Column style={styles.value}>{orgName}</Column>
        </Row>
        <Row style={styles.row}>
          <Column style={styles.label}>Current Plan</Column>
          <Column style={styles.value}>{currentPlan}</Column>
        </Row>
        <Row style={styles.row}>
          <Column style={styles.label}>Submitted</Column>
          <Column style={styles.value}>{submittedDate}</Column>
        </Row>
      </Section>

      {message && (
        <Section style={styles.messageCard}>
          <Text style={styles.cardHeading}>Message</Text>
          <Hr style={styles.divider} />
          <Text style={styles.messageText}>{message}</Text>
        </Section>
      )}

      <Section style={styles.actionCard}>
        <Text style={styles.actionText}>
          Reply directly to this email or reach the contact at{' '}
          <a href={`mailto:${contactEmail}`} style={styles.link}>{contactEmail}</a>{' '}
          to schedule a discovery call.
        </Text>
      </Section>
    </BaseLayout>
  );
}

const styles: Record<string, React.CSSProperties> = {
  heading: {
    fontSize: '20px',
    fontWeight: '700',
    color: EMAIL_THEME.colors.primary,
    marginBottom: '12px',
  },
  body: {
    fontSize: '15px',
    color: EMAIL_THEME.colors.text,
    lineHeight: '1.6',
    marginBottom: '24px',
  },
  infoCard: {
    backgroundColor: EMAIL_THEME.colors.cardBackground,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius: '8px',
    padding: '20px',
    marginBottom: '16px',
  },
  messageCard: {
    backgroundColor: EMAIL_THEME.colors.background,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius: '8px',
    padding: '20px',
    marginBottom: '16px',
  },
  actionCard: {
    backgroundColor: EMAIL_THEME.colors.successBg,
    border: `1px solid ${EMAIL_THEME.colors.success}`,
    borderRadius: '8px',
    padding: '16px',
    marginBottom: '24px',
  },
  cardHeading: {
    fontSize: '13px',
    fontWeight: '600',
    color: EMAIL_THEME.colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: '12px',
  },
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    marginBottom: '12px',
  },
  row: {
    marginBottom: '8px',
  },
  label: {
    width: '120px',
    fontSize: '13px',
    color: EMAIL_THEME.colors.textSecondary,
    fontWeight: '500',
    verticalAlign: 'top',
    paddingRight: '12px',
  },
  value: {
    fontSize: '13px',
    color: EMAIL_THEME.colors.text,
    fontWeight: '600',
  },
  valueLink: {
    fontSize: '13px',
  },
  link: {
    color: EMAIL_THEME.colors.primary,
    textDecoration: 'none',
    fontWeight: '600',
  },
  messageText: {
    fontSize: '14px',
    color: EMAIL_THEME.colors.text,
    lineHeight: '1.6',
    whiteSpace: 'pre-wrap',
  },
  actionText: {
    fontSize: '14px',
    color: EMAIL_THEME.colors.success,
    margin: '0',
  },
};
