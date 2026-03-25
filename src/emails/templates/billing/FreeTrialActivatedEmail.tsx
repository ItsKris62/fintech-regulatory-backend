import * as React from 'react';
import { Section, Text, Row, Column } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface FreeTrialActivatedEmailProps {
  userName:     string;
  trialEndsAt:  string; // ISO date string
  dashboardUrl: string;
}

export function FreeTrialActivatedEmail({
  userName,
  trialEndsAt,
  dashboardUrl,
}: FreeTrialActivatedEmailProps) {
  const endDate = new Date(trialEndsAt).toLocaleDateString('en-KE', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const features: Array<{ label: string; limit: string }> = [
    { label: 'Compliance Queries',   limit: '25' },
    { label: 'Gap Analyses',          limit: '5' },
    { label: 'Compliance Checklists', limit: '5' },
    { label: 'Vault Uploads',         limit: '10' },
  ];

  return (
    <BaseLayout preheaderText="Your 7-day SheriaBot free trial has started — explore all premium features">
      <Text style={styles.greeting}>Hi {userName},</Text>

      <Text style={styles.body}>
        Your free 7-day SheriaBot trial is now active! You have full access to our
        premium compliance tools until <strong>{endDate}</strong>.
      </Text>

      {/* Feature quota table */}
      <Section style={styles.quotaBox}>
        <Text style={styles.quotaTitle}>Your trial includes:</Text>
        {features.map(({ label, limit }) => (
          <Row key={label} style={styles.quotaRow}>
            <Column style={styles.quotaLabel}>{label}</Column>
            <Column style={styles.quotaValue}>{limit}</Column>
          </Row>
        ))}
      </Section>

      <Text style={styles.body}>
        No credit card required. If you'd like to continue after the trial,
        simply choose a plan before <strong>{endDate}</strong>.
      </Text>

      <Section style={styles.ctaSection}>
        <EmailButton href={dashboardUrl} variant="primary">
          Go to Dashboard
        </EmailButton>
      </Section>

      <Text style={styles.note}>
        Questions about the trial? Reply to this email — we're here to help.
      </Text>
    </BaseLayout>
  );
}

export const FreeTrialActivatedEmailSubject = 'Your SheriaBot free trial has started 🎉';

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
  quotaBox: {
    backgroundColor: EMAIL_THEME.colors.background,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius: '6px',
    padding: '16px 18px',
    margin: '0 0 20px',
  },
  quotaTitle: {
    color: EMAIL_THEME.colors.text,
    fontSize: '13px',
    fontWeight: '600',
    margin: '0 0 10px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  quotaRow: {
    margin: '0 0 6px',
  },
  quotaLabel: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '14px',
    width: '70%',
  },
  quotaValue: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    fontWeight: '600',
    textAlign: 'right',
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
