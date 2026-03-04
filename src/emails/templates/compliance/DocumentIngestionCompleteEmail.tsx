import * as React from 'react';
import { Section, Text } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface DocumentIngestionCompleteEmailProps {
  userName: string;
  documentName: string;
  chunksProcessed: number;
  status: 'success' | 'partial' | 'failed';
  dashboardUrl: string;
  errorDetails?: string;
}

export function DocumentIngestionCompleteEmail({
  userName,
  documentName,
  chunksProcessed,
  status,
  dashboardUrl,
  errorDetails,
}: DocumentIngestionCompleteEmailProps) {
  return (
    <BaseLayout
      preheaderText={`Document processing update for ${documentName}`}
      showUnsubscribe={true}
    >
      <Text style={styles.greeting}>Hi {userName},</Text>

      {status === 'success' && (
        <>
          <Section style={styles.successBanner}>
            <Text style={styles.successText}>
              &#10003; Your document &ldquo;{documentName}&rdquo; has been processed and indexed.{' '}
              <strong>{chunksProcessed}</strong> sections are now searchable.
            </Text>
          </Section>
        </>
      )}

      {status === 'partial' && (
        <>
          <Section style={styles.warningBanner}>
            <Text style={styles.warningText}>
              &#9888; Your document &ldquo;{documentName}&rdquo; was partially processed.
              Some sections may not be available.
            </Text>
          </Section>
          <Text style={styles.body}>
            <strong>{chunksProcessed}</strong> sections were successfully indexed.
          </Text>
        </>
      )}

      {status === 'failed' && (
        <>
          <Section style={styles.dangerBanner}>
            <Text style={styles.dangerText}>
              &#10060; We could not process your document &ldquo;{documentName}&rdquo;.
            </Text>
            {errorDetails && (
              <Text style={styles.errorDetails}>Error: {errorDetails}</Text>
            )}
          </Section>
        </>
      )}

      <Section style={styles.ctaSection}>
        <EmailButton href={dashboardUrl}>View in Dashboard</EmailButton>
      </Section>
    </BaseLayout>
  );
}

export const DocumentIngestionCompleteEmailSubject = 'Regulatory Document Processing Complete';

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
    margin: '16px 0',
  },
  successBanner: {
    backgroundColor: EMAIL_THEME.colors.successBg,
    borderLeft: `4px solid ${EMAIL_THEME.colors.success}`,
    borderRadius: '4px',
    padding: '16px',
    margin: '0 0 20px',
  },
  successText: {
    color: EMAIL_THEME.colors.success,
    fontSize: '14px',
    fontWeight: '600',
    margin: '0',
  },
  warningBanner: {
    backgroundColor: EMAIL_THEME.colors.warningBg,
    borderLeft: `4px solid ${EMAIL_THEME.colors.warning}`,
    borderRadius: '4px',
    padding: '16px',
    margin: '0 0 16px',
  },
  warningText: {
    color: EMAIL_THEME.colors.warning,
    fontSize: '14px',
    fontWeight: '600',
    margin: '0',
  },
  dangerBanner: {
    backgroundColor: EMAIL_THEME.colors.dangerBg,
    borderLeft: `4px solid ${EMAIL_THEME.colors.danger}`,
    borderRadius: '4px',
    padding: '16px',
    margin: '0 0 20px',
  },
  dangerText: {
    color: EMAIL_THEME.colors.danger,
    fontSize: '14px',
    fontWeight: '600',
    margin: '0 0 4px',
  },
  errorDetails: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    margin: '4px 0 0',
    fontStyle: 'italic',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '24px 0',
  },
};
