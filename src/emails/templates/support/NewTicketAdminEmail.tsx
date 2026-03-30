import * as React from 'react';
import { Section, Text, Hr, Row, Column } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME, SHERIABOT_URL } from '../../theme';

export interface NewTicketAdminEmailProps {
  ticketNumber: string;
  subject: string;
  userName: string;
  userEmail: string;
  category: string;
  priority: string;
  description: string;
}

export function NewTicketAdminEmail({
  ticketNumber,
  subject,
  userName,
  userEmail,
  category,
  priority,
  description,
}: NewTicketAdminEmailProps) {
  const adminUrl = `${SHERIABOT_URL}/admin/support/${ticketNumber}`;
  const descriptionPreview = description.length > 300 ? `${description.slice(0, 300)}…` : description;

  return (
    <BaseLayout preheaderText={`New support ticket from ${userName}: ${subject}`}>
      <Text style={styles.heading}>New Support Ticket Submitted</Text>
      <Text style={styles.body}>
        A new support ticket has been submitted and requires your attention.
      </Text>

      <Section style={styles.detailsBox}>
        <Row style={styles.detailRow}>
          <Column style={styles.detailLabel}>Ticket Number</Column>
          <Column style={styles.detailValue}>{ticketNumber}</Column>
        </Row>
        <Row style={styles.detailRow}>
          <Column style={styles.detailLabel}>Subject</Column>
          <Column style={styles.detailValue}>{subject}</Column>
        </Row>
        <Row style={styles.detailRow}>
          <Column style={styles.detailLabel}>User</Column>
          <Column style={styles.detailValue}>{userName} ({userEmail})</Column>
        </Row>
        <Row style={styles.detailRow}>
          <Column style={styles.detailLabel}>Category</Column>
          <Column style={styles.detailValue}>{category.replace(/_/g, ' ')}</Column>
        </Row>
        <Row style={styles.detailRow}>
          <Column style={styles.detailLabel}>Priority</Column>
          <Column style={{ ...styles.detailValue, ...priorityStyle(priority) }}>{priority}</Column>
        </Row>
      </Section>

      <Hr style={styles.divider} />

      <Text style={styles.sectionLabel}>Description</Text>
      <Section style={styles.descriptionBox}>
        <Text style={styles.descriptionText}>{descriptionPreview}</Text>
      </Section>

      <Section style={styles.ctaSection}>
        <EmailButton href={adminUrl}>View in Admin Dashboard</EmailButton>
      </Section>
    </BaseLayout>
  );
}

export const getNewTicketAdminSubject = (ticketNumber: string, subject: string) =>
  `[SheriaBot] New Support Ticket: ${ticketNumber} - ${subject}`;

function priorityStyle(priority: string): React.CSSProperties {
  const map: Record<string, React.CSSProperties> = {
    URGENT: { color: EMAIL_THEME.colors.danger, fontWeight: '700' },
    HIGH:   { color: EMAIL_THEME.colors.warning, fontWeight: '600' },
    MEDIUM: { color: EMAIL_THEME.colors.text },
    LOW:    { color: EMAIL_THEME.colors.textSecondary },
  };
  return map[priority] ?? {};
}

const styles: Record<string, React.CSSProperties> = {
  heading: {
    color: EMAIL_THEME.colors.primary,
    fontSize: '20px',
    fontWeight: '700',
    margin: '0 0 12px',
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
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    margin: '24px 0',
  },
  sectionLabel: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '12px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    margin: '0 0 8px',
  },
  descriptionBox: {
    backgroundColor: EMAIL_THEME.colors.background,
    borderRadius: '6px',
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    padding: '16px',
    marginBottom: '24px',
  },
  descriptionText: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    lineHeight: '1.6',
    margin: '0',
    whiteSpace: 'pre-wrap',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '24px 0 0',
  },
};
