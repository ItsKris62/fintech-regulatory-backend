import * as React from 'react';
import { Section, Text, Row, Column } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface FreeTrialExpiredEmailProps {
  userName:   string;
  usage: {
    complianceQueries: number;
    gapAnalyses:       number;
    checklists:        number;
    vaultUploads:      number;
  };
  upgradeUrl: string;
}

export function FreeTrialExpiredEmail({
  userName,
  usage,
  upgradeUrl,
}: FreeTrialExpiredEmailProps) {
  const usageSummary: Array<{ label: string; current: number }> = [
    { label: 'Compliance queries run', current: usage.complianceQueries },
    { label: 'Gap analyses completed', current: usage.gapAnalyses },
    { label: 'Checklists generated',   current: usage.checklists },
    { label: 'Documents uploaded',     current: usage.vaultUploads },
  ];

  const hadActivity = Object.values(usage).some((v) => v > 0);

  return (
    <BaseLayout preheaderText="Your SheriaBot free trial has ended — upgrade to restore full access">
      <Text style={styles.greeting}>Hi {userName},</Text>

      <Text style={styles.body}>
        Your 7-day SheriaBot free trial has ended. Your account has reverted to the free
        Regulator tier, and access to premium features has been paused.
      </Text>

      {hadActivity && (
        <>
          <Text style={styles.subHeading}>Your trial activity:</Text>
          <Section style={styles.usageBox}>
            {usageSummary.map(({ label, current }) => (
              <Row key={label} style={styles.usageRow}>
                <Column style={styles.usageLabel}>{label}</Column>
                <Column style={styles.usageValue}>{current}</Column>
              </Row>
            ))}
          </Section>
        </>
      )}

      <Text style={styles.body}>
        Ready to continue? Upgrade to a SheriaBot plan to restore full access to AI-powered
        compliance tools — policies, gap analysis, checklists, and more.
      </Text>

      <Section style={styles.ctaSection}>
        <EmailButton href={upgradeUrl} variant="primary">
          View Plans &amp; Upgrade
        </EmailButton>
      </Section>

      <Text style={styles.note}>
        Need help choosing a plan? Reply to this email — our team is happy to help you find
        the right fit for your business.
      </Text>
    </BaseLayout>
  );
}

export const FreeTrialExpiredEmailSubject = 'Your SheriaBot free trial has ended';

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
  subHeading: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    fontWeight: '600',
    margin: '0 0 8px',
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
