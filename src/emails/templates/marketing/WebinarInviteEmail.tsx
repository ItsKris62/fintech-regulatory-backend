/**
 * WebinarInviteEmail
 *
 * Webinar and event invitations.
 *
 * Subject suggestion:
 *   "You're invited: {eventTitle} — {eventDate}"
 */

import * as React from 'react';
import { Text, Section, Hr } from '@react-email/components';
import { MarketingBaseLayout } from './MarketingBaseLayout';
import { MarketingEmailButton } from '../../components/MarketingEmailButton';
import { EMAIL_THEME } from '../../theme';

export interface WebinarInviteEmailProps {
  recipientFirstName?: string;
  eventTitle: string;
  eventDate: string;
  eventTime: string;
  eventLocation: string;
  speakerNames: string[];
  agenda: string[];
  registrationUrl: string;
  unsubscribeUrl: string;
}

export default function WebinarInviteEmail({
  recipientFirstName,
  eventTitle,
  eventDate,
  eventTime,
  eventLocation,
  speakerNames,
  agenda,
  registrationUrl,
  unsubscribeUrl,
}: WebinarInviteEmailProps) {
  const greeting = recipientFirstName ? `Hi ${recipientFirstName},` : 'Hi there,';
  const speakerList = speakerNames.length === 1
    ? speakerNames[0]
    : speakerNames.slice(0, -1).join(', ') + ' and ' + speakerNames[speakerNames.length - 1];

  return (
    <MarketingBaseLayout
      preheaderText={`${eventTitle} — ${eventDate}, ${eventTime}. Register now.`}
      unsubscribeUrl={unsubscribeUrl}
      campaignName="SheriaBot Events"
    >
      {/* Event badge */}
      <Section style={styles.badgeSection}>
        <Text style={styles.badge}>EVENT INVITATION</Text>
      </Section>

      {/* Greeting */}
      <Text style={styles.greeting}>{greeting}</Text>

      {/* Event title */}
      <Text style={styles.headline}>{eventTitle}</Text>

      {/* Event details card */}
      <Section style={styles.detailsCard}>
        <Text style={styles.detailRow}>
          <strong>Date:</strong> {eventDate}
        </Text>
        <Text style={styles.detailRow}>
          <strong>Time:</strong> {eventTime}
        </Text>
        <Text style={styles.detailRow}>
          <strong>Location:</strong> {eventLocation}
        </Text>
        {speakerNames.length > 0 && (
          <Text style={styles.detailRow}>
            <strong>{speakerNames.length === 1 ? 'Speaker' : 'Speakers'}:</strong> {speakerList}
          </Text>
        )}
      </Section>

      <Hr style={styles.divider} />

      {/* Agenda */}
      {agenda.length > 0 && (
        <>
          <Text style={styles.sectionHeading}>Agenda</Text>
          <Section style={styles.agendaSection}>
            {agenda.map((item, index) => (
              <Text key={index} style={styles.agendaItem}>
                {index + 1}. {item}
              </Text>
            ))}
          </Section>
        </>
      )}

      {/* CTA */}
      <MarketingEmailButton href={registrationUrl} variant="primary">
        Register Now
      </MarketingEmailButton>

      <Text style={styles.footer}>
        Registration is free. A confirmation with joining details will be sent
        after you register.
      </Text>

      <Text style={styles.signoff}>
        — The SheriaBot Team
      </Text>
    </MarketingBaseLayout>
  );
}

const styles: Record<string, React.CSSProperties> = {
  badgeSection: {
    margin: '0 0 12px',
  },
  badge: {
    backgroundColor: '#7C3AED',
    color:           '#FFFFFF',
    fontSize:        '11px',
    fontWeight:      '700',
    letterSpacing:   '0.08em',
    padding:         '4px 10px',
    borderRadius:    '4px',
    display:         'inline-block',
    margin:          '0',
  },
  greeting: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '16px',
    lineHeight: '1.5',
    margin:     '0 0 16px',
  },
  headline: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '22px',
    fontWeight: '700',
    lineHeight: '1.3',
    margin:     '0 0 16px',
  },
  detailsCard: {
    backgroundColor: EMAIL_THEME.colors.background,
    border:          `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius:    '6px',
    padding:         '16px 20px',
    margin:          '0 0 16px',
  },
  detailRow: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '14px',
    lineHeight: '1.6',
    margin:     '0 0 6px',
  },
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    margin:      '20px 0',
  },
  sectionHeading: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '15px',
    fontWeight: '600',
    margin:     '0 0 12px',
  },
  agendaSection: {
    backgroundColor: EMAIL_THEME.colors.successBg,
    borderLeft:      `4px solid ${EMAIL_THEME.colors.primary}`,
    borderRadius:    '4px',
    padding:         '16px 20px',
    margin:          '0 0 16px',
  },
  agendaItem: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '14px',
    lineHeight: '1.6',
    margin:     '0 0 6px',
  },
  footer: {
    color:      EMAIL_THEME.colors.textSecondary,
    fontSize:   '13px',
    lineHeight: '1.5',
    margin:     '0 0 16px',
    textAlign:  'center',
  },
  signoff: {
    color:      EMAIL_THEME.colors.textSecondary,
    fontSize:   '14px',
    lineHeight: '1.5',
    margin:     '16px 0 0',
  },
};
