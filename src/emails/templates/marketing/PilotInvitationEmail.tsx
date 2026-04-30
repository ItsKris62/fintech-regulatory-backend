/**
 * PilotInvitationEmail
 *
 * Sent to curated contacts (fintech founders, compliance officers, etc.)
 * inviting them to apply for the SheriaBot pilot programme.
 *
 * Subject suggestion:
 *   "Invitation to the SheriaBot Pilot — early access for {recipientCompanyName}"
 */

import * as React from 'react';
import { Text, Section, Hr } from '@react-email/components';
import { MarketingBaseLayout } from './MarketingBaseLayout';
import { MarketingEmailButton } from '../../components/MarketingEmailButton';
import { EMAIL_THEME } from '../../theme';

export interface PilotInvitationEmailProps {
  recipientFirstName?: string;
  recipientCompanyName?: string;
  applicationUrl: string;
  unsubscribeUrl: string;
  expiresInDays: number;
  inviterName?: string;
}

export default function PilotInvitationEmail({
  recipientFirstName,
  recipientCompanyName,
  applicationUrl,
  unsubscribeUrl,
  expiresInDays,
  inviterName,
}: PilotInvitationEmailProps) {
  const greeting = recipientFirstName ? `Hi ${recipientFirstName},` : 'Hi there,';
  const companyRef = recipientCompanyName ? ` for ${recipientCompanyName}` : '';

  return (
    <MarketingBaseLayout
      preheaderText={`You're invited to join the SheriaBot Pilot — full Enterprise access${companyRef}, no payment required.`}
      unsubscribeUrl={unsubscribeUrl}
      recipientEmail={undefined}
      campaignName="SheriaBot Pilot Programme"
    >
      {/* Greeting */}
      <Text style={styles.greeting}>{greeting}</Text>

      {/* Hero headline */}
      <Text style={styles.headline}>
        Cut compliance gap analysis from weeks to hours.
      </Text>

      <Text style={styles.body}>
        We&apos;re inviting a small group of Kenyan fintech teams to join the SheriaBot Pilot
        Programme — full Enterprise access, no payment required, for {expiresInDays} days.
      </Text>

      {/* Benefits */}
      <Section style={styles.benefitsSection}>
        <Text style={styles.benefitsHeading}>What you get:</Text>
        <Text style={styles.bulletItem}>
          ✓ Full coverage of CBK Prudential Guidelines, DPA 2019, AML/CFT, and CMA frameworks
        </Text>
        <Text style={styles.bulletItem}>
          ✓ Audit-ready policy generation in minutes, with citations to source regulations
        </Text>
        <Text style={styles.bulletItem}>
          ✓ Direct AI compliance queries — ask anything, get answers grounded in Kenyan law
        </Text>
      </Section>

      <Hr style={styles.divider} />

      {/* CTA */}
      <Text style={styles.body}>
        This invitation is for {recipientCompanyName ?? 'your team'} specifically.
        The pilot includes full Enterprise tier access — gap analysis, policy generation,
        regulatory alerts, and the compliance vault — at no cost.
      </Text>

      <MarketingEmailButton href={applicationUrl} variant="primary">
        Apply for the Pilot Programme
      </MarketingEmailButton>

      {/* Expiry notice */}
      <Text style={styles.expiry}>
        This invitation expires in {expiresInDays} days. Applications are reviewed
        on a rolling basis.
      </Text>

      {/* Sign-off */}
      {inviterName ? (
        <Text style={styles.signoff}>
          — {inviterName}, SheriaBot
        </Text>
      ) : (
        <Text style={styles.signoff}>
          — The SheriaBot Team
        </Text>
      )}
    </MarketingBaseLayout>
  );
}

const styles: Record<string, React.CSSProperties> = {
  greeting: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '16px',
    lineHeight: '1.5',
    margin:     '0 0 16px',
  },
  headline: {
    color:       EMAIL_THEME.colors.primary,
    fontSize:    '24px',
    fontWeight:  '700',
    lineHeight:  '1.3',
    margin:      '0 0 16px',
  },
  body: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '15px',
    lineHeight: '1.6',
    margin:     '0 0 16px',
  },
  benefitsSection: {
    backgroundColor: EMAIL_THEME.colors.successBg,
    borderLeft:      `4px solid ${EMAIL_THEME.colors.primary}`,
    borderRadius:    '4px',
    padding:         '16px 20px',
    margin:          '0 0 16px',
  },
  benefitsHeading: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '14px',
    fontWeight: '600',
    margin:     '0 0 8px',
  },
  bulletItem: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '14px',
    lineHeight: '1.6',
    margin:     '0 0 6px',
  },
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    margin:      '24px 0',
  },
  expiry: {
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
