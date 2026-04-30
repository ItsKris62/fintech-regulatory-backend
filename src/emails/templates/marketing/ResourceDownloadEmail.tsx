/**
 * ResourceDownloadEmail
 *
 * Lead-magnet delivery. E.g., "Here's the Kenya Fintech Compliance Whitepaper
 * you requested."
 *
 * Subject suggestion:
 *   "Your download: {resourceTitle}"
 */

import * as React from 'react';
import { Text, Section, Hr } from '@react-email/components';
import { MarketingBaseLayout } from './MarketingBaseLayout';
import { MarketingEmailButton } from '../../components/MarketingEmailButton';
import { EMAIL_THEME } from '../../theme';

export interface ResourceDownloadEmailProps {
  recipientFirstName?: string;
  resourceTitle: string;
  resourceDescription: string;
  downloadUrl: string;
  pageCount?: number;
  fileFormat?: string;
  unsubscribeUrl: string;
}

export default function ResourceDownloadEmail({
  recipientFirstName,
  resourceTitle,
  resourceDescription,
  downloadUrl,
  pageCount,
  fileFormat,
  unsubscribeUrl,
}: ResourceDownloadEmailProps) {
  const greeting = recipientFirstName ? `Hi ${recipientFirstName},` : 'Hi there,';
  const fileMeta = [
    fileFormat,
    pageCount ? `${pageCount} pages` : undefined,
  ].filter(Boolean).join(' · ');

  return (
    <MarketingBaseLayout
      preheaderText={`Your download is ready: ${resourceTitle}`}
      unsubscribeUrl={unsubscribeUrl}
      campaignName="SheriaBot Resources"
    >
      {/* Badge */}
      <Section style={styles.badgeSection}>
        <Text style={styles.badge}>YOUR DOWNLOAD IS READY</Text>
      </Section>

      {/* Greeting */}
      <Text style={styles.greeting}>{greeting}</Text>

      <Text style={styles.body}>
        Here&apos;s the resource you requested:
      </Text>

      {/* Resource card */}
      <Section style={styles.resourceCard}>
        <Text style={styles.resourceTitle}>{resourceTitle}</Text>
        {fileMeta && (
          <Text style={styles.fileMeta}>{fileMeta}</Text>
        )}
        <Text style={styles.resourceDescription}>{resourceDescription}</Text>
      </Section>

      {/* CTA */}
      <MarketingEmailButton href={downloadUrl} variant="primary">
        Download Now
      </MarketingEmailButton>

      <Hr style={styles.divider} />

      <Text style={styles.footer}>
        This link is for your personal use. It will remain active for 30 days.
        If you have questions about the content, reply to this email.
      </Text>

      <Text style={styles.signoff}>
        — The SheriaBot Team
      </Text>
    </MarketingBaseLayout>
  );
}

const styles: Record<string, React.CSSProperties> = {
  badgeSection: {
    margin: '0 0 12px',
  },
  badge: {
    backgroundColor: EMAIL_THEME.colors.primary,
    color:           '#FFFFFF',
    fontSize:        '11px',
    fontWeight:      '700',
    letterSpacing:   '0.08em',
    padding:         '4px 10px',
    borderRadius:    '4px',
    display:         'inline-block',
    margin:          '0',
  },
  greeting: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '16px',
    lineHeight: '1.5',
    margin:     '0 0 16px',
  },
  body: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '15px',
    lineHeight: '1.6',
    margin:     '0 0 16px',
  },
  resourceCard: {
    backgroundColor: EMAIL_THEME.colors.successBg,
    border:          `1px solid ${EMAIL_THEME.colors.primary}`,
    borderRadius:    '6px',
    padding:         '20px 24px',
    margin:          '0 0 16px',
  },
  resourceTitle: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '18px',
    fontWeight: '700',
    lineHeight: '1.3',
    margin:     '0 0 6px',
  },
  fileMeta: {
    color:      EMAIL_THEME.colors.textSecondary,
    fontSize:   '12px',
    margin:     '0 0 10px',
  },
  resourceDescription: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '14px',
    lineHeight: '1.6',
    margin:     '0',
  },
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    margin:      '20px 0',
  },
  footer: {
    color:      EMAIL_THEME.colors.textSecondary,
    fontSize:   '13px',
    lineHeight: '1.5',
    margin:     '0 0 16px',
  },
  signoff: {
    color:      EMAIL_THEME.colors.textSecondary,
    fontSize:   '14px',
    lineHeight: '1.5',
    margin:     '16px 0 0',
  },
};
