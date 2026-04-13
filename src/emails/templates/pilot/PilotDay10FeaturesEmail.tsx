import * as React from 'react';
import { Section, Text, Row, Column } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface PilotDay10FeaturesEmailProps {
  userName:      string;
  daysRemaining: number;
  dashboardUrl:  string;
}

export function PilotDay10FeaturesEmail({
  userName,
  daysRemaining,
  dashboardUrl,
}: PilotDay10FeaturesEmailProps) {
  const spotlights: Array<{ title: string; detail: string; path: string }> = [
    {
      title:  'Gap Analysis',
      detail: 'Upload any existing policy document — SheriaBot identifies missing controls and maps them to CBK, CMA, and other Kenyan regulatory requirements.',
      path:   'Dashboard > Compliance > Gap Analysis',
    },
    {
      title:  'AI Compliance Query',
      detail: 'Ask complex regulatory questions in plain English. Answers are grounded in actual regulatory texts with citations — not generic advice.',
      path:   'Dashboard > Compliance > Ask a Question',
    },
    {
      title:  'Document Vault',
      detail: 'Upload and categorise your compliance documents. Every upload is indexed so answers to future queries draw on your own policies.',
      path:   'Dashboard > Vault',
    },
  ];

  return (
    <BaseLayout preheaderText={`${daysRemaining} days left — don't miss these features in your pilot`}>
      <Text style={styles.greeting}>Hi {userName},</Text>

      <Text style={styles.body}>
        With <strong>{daysRemaining} days left</strong> in your pilot, we wanted to highlight a
        few features that are often discovered late — but tend to be the most impactful.
      </Text>

      <Section style={styles.spotlightList}>
        {spotlights.map(({ title, detail, path }, idx) => (
          <Section key={title} style={idx < spotlights.length - 1 ? styles.spotlightCard : styles.spotlightCardLast}>
            <Row>
              <Column>
                <Text style={styles.spotlightTitle}>{title}</Text>
                <Text style={styles.spotlightDetail}>{detail}</Text>
                <Text style={styles.spotlightPath}>{path}</Text>
              </Column>
            </Row>
          </Section>
        ))}
      </Section>

      <Section style={styles.ctaSection}>
        <EmailButton href={dashboardUrl} variant="primary">
          Explore These Features
        </EmailButton>
      </Section>

      <Text style={styles.note}>
        If any of these aren't meeting your needs, reply and tell us — we may have a workaround
        or it may become our next sprint priority.
      </Text>
    </BaseLayout>
  );
}

export const PilotDay10FeaturesEmailSubject = "Features you haven't tried yet in your SheriaBot pilot";

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
    margin: '0 0 20px',
  },
  spotlightList: {
    margin: '0 0 20px',
  },
  spotlightCard: {
    backgroundColor: EMAIL_THEME.colors.background,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius: '6px',
    padding: '14px 16px',
    margin: '0 0 10px',
  },
  spotlightCardLast: {
    backgroundColor: EMAIL_THEME.colors.background,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius: '6px',
    padding: '14px 16px',
    margin: '0',
  },
  spotlightTitle: {
    color: EMAIL_THEME.colors.primary,
    fontSize: '14px',
    fontWeight: '700',
    margin: '0 0 4px',
  },
  spotlightDetail: {
    color: EMAIL_THEME.colors.text,
    fontSize: '13px',
    lineHeight: '1.5',
    margin: '0 0 6px',
  },
  spotlightPath: {
    color: EMAIL_THEME.colors.textMuted,
    fontSize: '12px',
    fontFamily: 'monospace',
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
