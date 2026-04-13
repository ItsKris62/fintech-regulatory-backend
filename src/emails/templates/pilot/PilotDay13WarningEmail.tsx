import * as React from 'react';
import { Section, Text } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface PilotDay13WarningEmailProps {
  userName:       string;
  pilotExpiresAt: string; // ISO date string
  dashboardUrl:   string;
}

export function PilotDay13WarningEmail({
  userName,
  pilotExpiresAt,
  dashboardUrl,
}: PilotDay13WarningEmailProps) {
  const expiryDate = new Date(pilotExpiresAt).toLocaleDateString('en-KE', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  return (
    <BaseLayout preheaderText="Your SheriaBot pilot access expires tomorrow — here's what happens next">
      <Text style={styles.greeting}>Hi {userName},</Text>

      <Section style={styles.warningBox}>
        <Text style={styles.warningText}>
          Your pilot access expires <strong>tomorrow, {expiryDate}</strong>.
        </Text>
      </Section>

      <Text style={styles.body}>
        After expiry your account moves to the free Regulator tier. Here's what you should know:
      </Text>

      <Section style={styles.infoList}>
        <Text style={styles.infoItem}>
          <strong>Your data is safe.</strong> All checklists, gap analyses, and vault documents
          you've created remain in your account — nothing is deleted.
        </Text>
        <Text style={styles.infoItem}>
          <strong>AI features are gated.</strong> Compliance queries and checklist generation
          require a paid plan after expiry.
        </Text>
        <Text style={styles.infoItem}>
          <strong>You can upgrade any time.</strong> Pick the plan that fits your team and all
          your work carries over instantly.
        </Text>
      </Section>

      <Text style={styles.body}>
        If you'd like to continue with full access, visit the billing page before tomorrow.
      </Text>

      <Section style={styles.ctaSection}>
        <EmailButton href={`${dashboardUrl}/billing`} variant="primary">
          View Pricing Plans
        </EmailButton>
      </Section>

      <Text style={styles.note}>
        Not ready to subscribe yet? No pressure — your account stays active on the free tier.
        We'd still love to hear your feedback. Reply to this email.
      </Text>
    </BaseLayout>
  );
}

export const PilotDay13WarningEmailSubject = 'Your SheriaBot pilot ends tomorrow — here\'s what to expect';

const styles: Record<string, React.CSSProperties> = {
  greeting: {
    color: EMAIL_THEME.colors.text,
    fontSize: '16px',
    fontWeight: '600',
    margin: '0 0 16px',
  },
  warningBox: {
    backgroundColor: EMAIL_THEME.colors.warningBg,
    border: `1px solid ${EMAIL_THEME.colors.warning}`,
    borderRadius: '6px',
    padding: '14px 16px',
    margin: '0 0 20px',
  },
  warningText: {
    color: EMAIL_THEME.colors.text,
    fontSize: '15px',
    margin: '0',
  },
  body: {
    color: EMAIL_THEME.colors.text,
    fontSize: '15px',
    lineHeight: '1.6',
    margin: '0 0 16px',
  },
  infoList: {
    margin: '0 0 20px',
  },
  infoItem: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '14px',
    lineHeight: '1.6',
    margin: '0 0 10px',
    paddingLeft: '4px',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '24px 0',
  },
  note: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    lineHeight: '1.5',
    textAlign: 'center',
    margin: '0',
  },
};
