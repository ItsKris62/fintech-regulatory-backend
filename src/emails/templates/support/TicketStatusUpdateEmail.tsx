import * as React from 'react';
import { Section, Text, Hr, Row, Column } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface TicketStatusUpdateEmailProps {
  ticketNumber: string;
  subject: string;
  userName: string;
  oldStatus: string;
  newStatus: string;
}

export function TicketStatusUpdateEmail({
  ticketNumber,
  subject,
  userName,
  oldStatus,
  newStatus,
}: TicketStatusUpdateEmailProps) {
  const ticketUrl = `${process.env.FRONTEND_URL || 'https://sheriabot.com'}/support/${ticketNumber}`;

  return (
    <BaseLayout preheaderText={`Your ticket ${ticketNumber} status has been updated to ${newStatus}`}>
      <Text style={styles.greeting}>Hi {userName},</Text>
      <Text style={styles.body}>
        Your support ticket status has been updated. Here are the details:
      </Text>

      <Section style={styles.detailsBox}>
        <Row style={styles.detailRow}>
          <Column style={styles.detailLabel}>Ticket</Column>
          <Column style={styles.ticketNumber}>{ticketNumber}</Column>
        </Row>
        <Row style={styles.detailRow}>
          <Column style={styles.detailLabel}>Subject</Column>
          <Column style={styles.detailValue}>{subject}</Column>
        </Row>
      </Section>

      <Section style={styles.statusChangeBox}>
        <Row>
          <Column style={styles.statusColumn}>
            <Text style={styles.statusLabel}>Previous Status</Text>
            <Text style={{ ...styles.statusBadge, ...statusStyle(oldStatus) }}>
              {formatStatus(oldStatus)}
            </Text>
          </Column>
          <Column style={styles.arrowColumn}>
            <Text style={styles.arrow}>→</Text>
          </Column>
          <Column style={styles.statusColumn}>
            <Text style={styles.statusLabel}>New Status</Text>
            <Text style={{ ...styles.statusBadge, ...statusStyle(newStatus) }}>
              {formatStatus(newStatus)}
            </Text>
          </Column>
        </Row>
      </Section>

      <Hr style={styles.divider} />

      {(newStatus === 'AWAITING_USER') && (
        <Text style={styles.actionNote}>
          Our team has responded to your ticket. Please review their response and reply if needed.
        </Text>
      )}
      {(newStatus === 'RESOLVED' || newStatus === 'CLOSED') && (
        <Text style={styles.actionNote}>
          Your ticket has been resolved. If you need further assistance, please open a new ticket.
        </Text>
      )}

      <Section style={styles.ctaSection}>
        <EmailButton href={ticketUrl}>View Ticket</EmailButton>
      </Section>
    </BaseLayout>
  );
}

export const getTicketStatusUpdateSubject = (ticketNumber: string, newStatus: string) =>
  `[SheriaBot] Ticket ${ticketNumber} - Status Updated to ${formatStatus(newStatus)}`;

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

function statusStyle(status: string): React.CSSProperties {
  const map: Record<string, React.CSSProperties> = {
    OPEN:          { backgroundColor: '#EFF6FF', color: '#1D4ED8' },
    IN_PROGRESS:   { backgroundColor: EMAIL_THEME.colors.successBg, color: EMAIL_THEME.colors.success },
    AWAITING_USER: { backgroundColor: EMAIL_THEME.colors.warningBg, color: EMAIL_THEME.colors.warning },
    RESOLVED:      { backgroundColor: '#F1F5F9', color: '#475569' },
    CLOSED:        { backgroundColor: '#F3F4F6', color: '#6B7280' },
  };
  return map[status] ?? { backgroundColor: '#F3F4F6', color: '#6B7280' };
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
  statusChangeBox: {
    padding: '20px',
    backgroundColor: EMAIL_THEME.colors.background,
    borderRadius: '8px',
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    marginBottom: '24px',
  },
  statusColumn: {
    textAlign: 'center',
    width: '40%',
  },
  arrowColumn: {
    textAlign: 'center',
    width: '20%',
  },
  statusLabel: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '11px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    margin: '0 0 8px',
  },
  statusBadge: {
    display: 'inline-block',
    borderRadius: '4px',
    padding: '4px 10px',
    fontSize: '12px',
    fontWeight: '600',
    textAlign: 'center',
    margin: '0',
  },
  arrow: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '24px',
    fontWeight: '300',
    margin: '20px 0 0',
  },
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    margin: '24px 0',
  },
  actionNote: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '14px',
    lineHeight: '1.6',
    margin: '0 0 24px',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '24px 0 0',
  },
};
