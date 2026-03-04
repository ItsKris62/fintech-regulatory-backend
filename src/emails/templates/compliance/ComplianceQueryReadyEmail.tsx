import * as React from 'react';
import { Section, Text } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface ComplianceQueryReadyEmailProps {
  userName: string;
  queryPreview: string;
  queryId: string;
  resultUrl: string;
  answeredAt: string;
}

export function ComplianceQueryReadyEmail({
  userName,
  queryPreview,
  resultUrl,
  answeredAt,
}: ComplianceQueryReadyEmailProps) {
  const truncated = queryPreview.length > 150
    ? queryPreview.slice(0, 150) + '...'
    : queryPreview;

  return (
    <BaseLayout
      preheaderText="Results are ready for your compliance query"
      showUnsubscribe={true}
    >
      <Text style={styles.greeting}>Hi {userName},</Text>
      <Text style={styles.body}>
        Your compliance query has been processed and results are ready.
      </Text>

      <Section style={styles.queryCard}>
        <Text style={styles.queryLabel}>Your Query</Text>
        <Text style={styles.queryText}>&ldquo;{truncated}&rdquo;</Text>
      </Section>

      <Section style={styles.ctaSection}>
        <EmailButton href={resultUrl}>View Results</EmailButton>
      </Section>

      <Text style={styles.timestamp}>Processed on {answeredAt}</Text>
    </BaseLayout>
  );
}

export const ComplianceQueryReadyEmailSubject = 'Your Compliance Query Results Are Ready';

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
  queryCard: {
    backgroundColor: EMAIL_THEME.colors.background,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius: '6px',
    padding: '16px',
    margin: '0 0 24px',
  },
  queryLabel: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '11px',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    margin: '0 0 8px',
  },
  queryText: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontStyle: 'italic',
    lineHeight: '1.5',
    margin: '0',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '24px 0',
  },
  timestamp: {
    color: EMAIL_THEME.colors.textMuted,
    fontSize: '12px',
    textAlign: 'center',
    margin: '8px 0 0',
  },
};
