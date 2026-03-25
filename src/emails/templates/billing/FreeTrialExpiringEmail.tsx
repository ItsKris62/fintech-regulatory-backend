import * as React from 'react';
import { Section, Text, Row, Column } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface FreeTrialExpiringEmailProps {
  userName:      string;
  daysRemaining: number;
  usage: {
    complianceQueries: number;
    gapAnalyses:       number;
    checklists:        number;
    vaultUploads:      number;
  };
  upgradeUrl: string;
}

export function FreeTrialExpiringEmail({
  userName,
  daysRemaining,
  usage,
  upgradeUrl,
}: FreeTrialExpiringEmailProps) {
  const dayLabel   = daysRemaining === 1 ? '1 day' : `${daysRemaining} days`;
  const isLastDay  = daysRemaining <= 1;
  const accentColor = isLastDay ? EMAIL_THEME.colors.danger : EMAIL_THEME.colors.warning;
  const bgColor     = isLastDay ? EMAIL_THEME.colors.dangerBg : EMAIL_THEME.colors.warningBg;

  const usageSummary: Array<{ label: string; current: number }> = [
    { label: 'Compliance queries run', current: usage.complianceQueries },
    { label: 'Gap analyses completed', current: usage.gapAnalyses },
    { label: 'Checklists generated',   current: usage.checklists },
    { label: 'Documents uploaded',     current: usage.vaultUploads },
  ];

  return (
    <BaseLayout preheaderText={`Your SheriaBot free trial ends in ${dayLabel} — upgrade to keep your access`}>
      <Text style={styles.greeting}>Hi {userName},</Text>

      <Section style={{ ...styles.urgencyBanner, backgroundColor: bgColor, borderColor: accentColor + '50' }}>
        <Text style={{ ...styles.urgencyText, color: accentColor }}>
          {isLastDay
            ? 'Last day of your free trial — upgrade now to avoid losing access'
            : `Your free trial ends in ${dayLabel}`}
        </Text>
      </Section>

      <Text style={styles.body}>
        Your SheriaBot free trial expires soon. Here's a summary of what you've used:
      </Text>

      <Section style={styles.usageBox}>
        {usageSummary.map(({ label, current }) => (
          <Row key={label} style={styles.usageRow}>
            <Column style={styles.usageLabel}>{label}</Column>
            <Column style={styles.usageValue}>{current}</Column>
          </Row>
        ))}
      </Section>

      <Text style={styles.body}>
        Upgrade to a paid plan before your trial ends to keep uninterrupted access to all
        SheriaBot compliance tools — no setup required.
      </Text>

      <Section style={styles.ctaSection}>
        <EmailButton href={upgradeUrl} variant="primary">
          Upgrade Now
        </EmailButton>
      </Section>

      <Text style={styles.note}>
        Not ready to upgrade? Your account will revert to the free Regulator tier at the end of your trial.
        No charges will ever be made without your consent.
      </Text>
    </BaseLayout>
  );
}

export function getFreeTrialExpiringSubject(daysRemaining: number): string {
  if (daysRemaining <= 1) return 'Your SheriaBot trial ends today — upgrade to continue';
  return `Your SheriaBot trial ends in ${daysRemaining} days`;
}

const styles: Record<string, React.CSSProperties> = {
  greeting: {
    color: EMAIL_THEME.colors.text,
    fontSize: '16px',
    fontWeight: '600',
    margin: '0 0 16px',
  },
  urgencyBanner: {
    border: '1px solid',
    borderRadius: '6px',
    padding: '14px 18px',
    margin: '0 0 20px',
  },
  urgencyText: {
    fontSize: '14px',
    fontWeight: '600',
    margin: '0',
    lineHeight: '1.4',
  },
  body: {
    color: EMAIL_THEME.colors.text,
    fontSize: '15px',
    lineHeight: '1.6',
    margin: '0 0 16px',
  },
  usageBox: {
    backgroundColor: EMAIL_THEME.colors.background,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius: '6px',
    padding: '14px 18px',
    margin: '0 0 20px',
  },
  usageRow: {
    margin: '0 0 6px',
  },
  usageLabel: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '14px',
    width: '75%',
  },
  usageValue: {
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
