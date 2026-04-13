import * as React from 'react';
import { Section, Text, Row, Column } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface PilotWelcomeEmailProps {
  userName:        string;
  organization:    string;
  pilotExpiresAt:  string; // ISO date string
  dashboardUrl:    string;
}

export function PilotWelcomeEmail({
  userName,
  organization,
  pilotExpiresAt,
  dashboardUrl,
}: PilotWelcomeEmailProps) {
  const expiryDate = new Date(pilotExpiresAt).toLocaleDateString('en-KE', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const features: Array<{ label: string; description: string }> = [
    { label: 'Compliance Checklist Generator', description: 'Generate a tailored regulatory checklist in minutes' },
    { label: 'AI Compliance Query',             description: 'Ask any regulatory question and get cited answers' },
    { label: 'Gap Analysis',                    description: 'Upload your policies to identify compliance gaps' },
    { label: 'Document Vault',                  description: 'Centralise and manage your regulatory documents' },
  ];

  return (
    <BaseLayout preheaderText={`Welcome to the SheriaBot pilot, ${userName} — your 14-day Enterprise access starts now`}>
      <Text style={styles.greeting}>Hi {userName},</Text>

      <Text style={styles.body}>
        Welcome to the <strong>SheriaBot Pilot Programme</strong>. You and the team at{' '}
        <strong>{organization}</strong> have been selected as a founding tester — thank you for
        helping us shape Kenya's leading fintech compliance platform.
      </Text>

      <Text style={styles.body}>
        Your <strong>full Enterprise-tier access</strong> is active until{' '}
        <strong>{expiryDate}</strong>. Here's what to explore first:
      </Text>

      <Section style={styles.featureBox}>
        {features.map(({ label, description }) => (
          <Row key={label} style={styles.featureRow}>
            <Column style={styles.featureDot}>&#9679;</Column>
            <Column>
              <Text style={styles.featureLabel}>{label}</Text>
              <Text style={styles.featureDesc}>{description}</Text>
            </Column>
          </Row>
        ))}
      </Section>

      <Section style={styles.ctaSection}>
        <EmailButton href={dashboardUrl} variant="primary">
          Open My Dashboard
        </EmailButton>
      </Section>

      <Text style={styles.note}>
        We'll be in touch throughout the pilot with tips and feature highlights. Reply to this
        email any time — your feedback directly shapes what we build next.
      </Text>
    </BaseLayout>
  );
}

export const PilotWelcomeEmailSubject = 'Welcome to the SheriaBot Pilot — your access is live';

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
  featureBox: {
    backgroundColor: EMAIL_THEME.colors.successBg,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius: '6px',
    padding: '16px 18px',
    margin: '0 0 20px',
  },
  featureRow: {
    margin: '0 0 10px',
  },
  featureDot: {
    color: EMAIL_THEME.colors.primary,
    fontSize: '8px',
    width: '18px',
    verticalAlign: 'top',
    paddingTop: '4px',
  },
  featureLabel: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    fontWeight: '600',
    margin: '0 0 2px',
  },
  featureDesc: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    margin: '0',
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
