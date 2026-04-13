import * as React from 'react';
import { Section, Text } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface PilotDay3NudgeEmailProps {
  userName:     string;
  dashboardUrl: string;
}

export function PilotDay3NudgeEmail({
  userName,
  dashboardUrl,
}: PilotDay3NudgeEmailProps) {
  return (
    <BaseLayout preheaderText="You still have 11 days of Enterprise access — pick up where you left off">
      <Text style={styles.greeting}>Hi {userName},</Text>

      <Text style={styles.body}>
        We noticed you haven't had a chance to log into SheriaBot yet. That's fine — getting
        started can feel like one more thing on the list.
      </Text>

      <Text style={styles.body}>
        If you have <strong>10 minutes today</strong>, the fastest way to see real value is the{' '}
        <strong>Compliance Checklist Generator</strong>. Tell it your business type, and it
        produces a prioritised regulatory checklist specific to your situation — no legal
        background needed.
      </Text>

      <Section style={styles.tipBox}>
        <Text style={styles.tipTitle}>Quick start</Text>
        <Text style={styles.tipText}>
          Dashboard &rarr; Compliance &rarr; Generate Checklist &rarr; Select your product type &rarr; Done.
        </Text>
      </Section>

      <Section style={styles.ctaSection}>
        <EmailButton href={dashboardUrl} variant="primary">
          Try It Now
        </EmailButton>
      </Section>

      <Text style={styles.note}>
        Stuck or have questions? Just reply — we respond within a few hours on business days.
      </Text>
    </BaseLayout>
  );
}

export const PilotDay3NudgeEmailSubject = 'Your SheriaBot pilot: a 10-minute quick start';

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
  tipBox: {
    backgroundColor: EMAIL_THEME.colors.background,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius: '6px',
    padding: '16px 18px',
    margin: '0 0 20px',
  },
  tipTitle: {
    color: EMAIL_THEME.colors.text,
    fontSize: '13px',
    fontWeight: '600',
    margin: '0 0 8px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  tipText: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '14px',
    lineHeight: '1.5',
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
