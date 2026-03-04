import * as React from 'react';
import { Section, Text } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface PolicyDocumentReadyEmailProps {
  userName: string;
  documentTitle: string;
  documentType: string;
  documentUrl: string;
  generatedAt: string;
}

export function PolicyDocumentReadyEmail({
  userName,
  documentTitle,
  documentType,
  documentUrl,
  generatedAt,
}: PolicyDocumentReadyEmailProps) {
  return (
    <BaseLayout
      preheaderText={`Your ${documentType} is ready for review on SheriaBot`}
      showUnsubscribe={true}
    >
      <Text style={styles.greeting}>Hi {userName},</Text>
      <Text style={styles.body}>
        Your <strong>{documentType}</strong> has been generated and is ready for review.
      </Text>

      <Section style={styles.documentCard}>
        <Text style={styles.documentLabel}>Document</Text>
        <Text style={styles.documentTitle}>{documentTitle}</Text>
        <Text style={styles.documentMeta}>
          {documentType} &middot; Generated {generatedAt}
        </Text>
      </Section>

      <Section style={styles.ctaSection}>
        <EmailButton href={documentUrl}>View Document</EmailButton>
      </Section>

      <Section style={styles.disclaimerBox}>
        <Text style={styles.disclaimerText}>
          <strong>Note:</strong> AI-generated policy documents should be reviewed by qualified
          compliance professionals before implementation.
        </Text>
      </Section>
    </BaseLayout>
  );
}

export const PolicyDocumentReadyEmailSubject = 'Your Policy Document Has Been Generated';

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
  documentCard: {
    backgroundColor: EMAIL_THEME.colors.background,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderLeft: `4px solid ${EMAIL_THEME.colors.accent}`,
    borderRadius: '0 6px 6px 0',
    padding: '16px',
    margin: '0 0 24px',
  },
  documentLabel: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '11px',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    margin: '0 0 6px',
  },
  documentTitle: {
    color: EMAIL_THEME.colors.primary,
    fontSize: '16px',
    fontWeight: '600',
    margin: '0 0 4px',
  },
  documentMeta: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    margin: '0',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '24px 0',
  },
  disclaimerBox: {
    backgroundColor: EMAIL_THEME.colors.background,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius: '4px',
    padding: '12px 16px',
    margin: '16px 0 0',
  },
  disclaimerText: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    lineHeight: '1.5',
    margin: '0',
  },
};
