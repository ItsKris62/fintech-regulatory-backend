import * as React from 'react';
import { Section, Text } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface PilotExpiredEmailProps {
  userName:     string;
  organization: string;
  dashboardUrl: string;
  surveyUrl?:   string;
}

export function PilotExpiredEmail({
  userName,
  organization,
  dashboardUrl,
  surveyUrl,
}: PilotExpiredEmailProps) {
  return (
    <BaseLayout preheaderText="Your SheriaBot pilot has ended — thank you for being a founding tester">
      <Text style={styles.greeting}>Hi {userName},</Text>

      <Text style={styles.body}>
        Your 14-day SheriaBot pilot has come to an end. On behalf of the whole team, thank you —
        you and <strong>{organization}</strong> helped us stress-test the platform in real
        conditions, and that makes a genuine difference.
      </Text>

      <Section style={styles.assuranceBox}>
        <Text style={styles.assuranceTitle}>Your data</Text>
        <Text style={styles.assuranceText}>
          Everything you created — checklists, gap analyses, vault documents — is still in your
          account. Nothing has been deleted. Your account is now on the free Regulator tier.
        </Text>
      </Section>

      <Text style={styles.body}>
        As a pilot tester you have access to an exclusive <strong>Founding Member rate</strong>{' '}
        if you choose to subscribe. Visit the billing page to see the offer applied to your
        account.
      </Text>

      <Section style={styles.ctaRow}>
        <EmailButton href={`${dashboardUrl}/billing`} variant="primary">
          See Founding Member Offer
        </EmailButton>
      </Section>

      {surveyUrl ? (
        <>
          <Text style={styles.surveyIntro}>
            We'd also love your honest feedback on the pilot:
          </Text>
          <Section style={styles.ctaRow}>
            <EmailButton href={surveyUrl} variant="secondary">
              Take the Final Survey (5 min)
            </EmailButton>
          </Section>
        </>
      ) : null}

      <Text style={styles.note}>
        Whether or not you subscribe, we're grateful. If there's anything you'd like to discuss,
        reply to this email and we'll get back to you promptly.
      </Text>
    </BaseLayout>
  );
}

export const PilotExpiredEmailSubject = 'Your SheriaBot pilot has ended — thank you';

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
    margin: '0 0 16px',
  },
  assuranceBox: {
    backgroundColor: EMAIL_THEME.colors.successBg,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius: '6px',
    padding: '14px 16px',
    margin: '0 0 20px',
  },
  assuranceTitle: {
    color: EMAIL_THEME.colors.text,
    fontSize: '13px',
    fontWeight: '600',
    margin: '0 0 6px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  assuranceText: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '14px',
    lineHeight: '1.5',
    margin: '0',
  },
  ctaRow: {
    textAlign: 'center',
    margin: '20px 0',
  },
  surveyIntro: {
    color: EMAIL_THEME.colors.text,
    fontSize: '15px',
    lineHeight: '1.6',
    margin: '0 0 4px',
  },
  note: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    lineHeight: '1.5',
    textAlign: 'center',
    margin: '0',
  },
};
