import * as React from 'react';
import { Section, Text, Hr } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface TicketResponseEmailProps {
  ticketNumber: string;
  subject: string;
  userName: string;
  responseMessage: string;
  responderName: string;
}

export function TicketResponseEmail({
  ticketNumber,
  subject,
  userName,
  responseMessage,
  responderName,
}: TicketResponseEmailProps) {
  const ticketUrl = `${process.env.FRONTEND_URL || 'https://sheriabot.com'}/support/${ticketNumber}`;

  return (
    <BaseLayout preheaderText={`New response from ${responderName} on ticket ${ticketNumber}`}>
      <Text style={styles.greeting}>Hi {userName},</Text>
      <Text style={styles.body}>
        You have a new response on your support ticket{' '}
        <span style={styles.ticketRef}>{ticketNumber}</span> — <em>{subject}</em>.
      </Text>

      <Hr style={styles.divider} />

      <Text style={styles.responseFromLabel}>Response from {responderName}:</Text>
      <Section style={styles.responseBox}>
        <Text style={styles.responseText}>{responseMessage}</Text>
      </Section>

      <Hr style={styles.divider} />

      <Text style={styles.replyPrompt}>
        Please review the response and reply if you need further clarification or if your issue
        has not been fully resolved.
      </Text>

      <Section style={styles.ctaSection}>
        <EmailButton href={ticketUrl}>View &amp; Reply</EmailButton>
      </Section>
    </BaseLayout>
  );
}

export const getTicketResponseSubject = (ticketNumber: string) =>
  `[SheriaBot] New Response on Ticket ${ticketNumber}`;

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
    margin: '0 0 0',
  },
  ticketRef: {
    color: EMAIL_THEME.colors.primary,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    margin: '24px 0',
  },
  responseFromLabel: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '12px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    margin: '0 0 10px',
  },
  responseBox: {
    backgroundColor: '#F8FAFC',
    borderLeft: `4px solid ${EMAIL_THEME.colors.success}`,
    borderRadius: '0 6px 6px 0',
    padding: '16px 20px',
    marginBottom: '8px',
  },
  responseText: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    lineHeight: '1.7',
    margin: '0',
    whiteSpace: 'pre-wrap',
  },
  replyPrompt: {
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
