/**
 * ComplianceUpdateEmail
 *
 * Triggered when a regulator publishes new guidelines — sent within 48 hours.
 * Positions SheriaBot as the authority that has already mapped the change.
 *
 * Subject suggestion:
 *   "{regulatorName} update: {updateTitle}"
 */

import * as React from 'react';
import { Text, Section, Hr } from '@react-email/components';
import { MarketingBaseLayout } from './MarketingBaseLayout';
import { MarketingEmailButton } from '../../components/MarketingEmailButton';
import { EMAIL_THEME } from '../../theme';

export interface ComplianceUpdateEmailProps {
  recipientFirstName?: string;
  updateTitle: string;
  regulatorName: string;
  publishedDate: string;
  summary: string;
  whoAffected: string;
  ctaUrl: string;
  unsubscribeUrl: string;
}

export default function ComplianceUpdateEmail({
  recipientFirstName,
  updateTitle,
  regulatorName,
  publishedDate,
  summary,
  whoAffected,
  ctaUrl,
  unsubscribeUrl,
}: ComplianceUpdateEmailProps) {
  const greeting = recipientFirstName ? `Hi ${recipientFirstName},` : 'Hi there,';

  return (
    <MarketingBaseLayout
      preheaderText={`${regulatorName} published new guidelines. We've mapped the compliance impact for you.`}
      unsubscribeUrl={unsubscribeUrl}
      campaignName="SheriaBot Regulatory Updates"
    >
      {/* Regulatory update badge */}
      <Section style={styles.badgeSection}>
        <Text style={styles.badge}>REGULATORY UPDATE</Text>
      </Section>

      {/* Greeting */}
      <Text style={styles.greeting}>{greeting}</Text>

      {/* Opening */}
      <Text style={styles.body}>
        {regulatorName} published <strong>{updateTitle}</strong> on {publishedDate}.
      </Text>

      {/* Summary */}
      <Section style={styles.summarySection}>
        <Text style={styles.summaryHeading}>Plain-English Summary</Text>
        <Text style={styles.summaryText}>{summary}</Text>
      </Section>

      {/* Who is affected */}
      <Section style={styles.affectedSection}>
        <Text style={styles.affectedLabel}>Who this affects:</Text>
        <Text style={styles.affectedText}>{whoAffected}</Text>
      </Section>

      <Hr style={styles.divider} />

      {/* SheriaBot mapping callout */}
      <Text style={styles.body}>
        We&apos;ve already mapped this update in SheriaBot. Your gap analysis and policy
        recommendations now reflect the new requirements — no manual review needed.
      </Text>

      <MarketingEmailButton href={ctaUrl} variant="primary">
        View Impact Analysis
      </MarketingEmailButton>

      <Text style={styles.footer}>
        SheriaBot monitors regulatory publications from CBK, ODPC, CMA, and CA.
        Updates are mapped within 48 hours of publication.
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
    backgroundColor: EMAIL_THEME.colors.warning,
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
  summarySection: {
    backgroundColor: EMAIL_THEME.colors.warningBg,
    borderLeft:      `4px solid ${EMAIL_THEME.colors.warning}`,
    borderRadius:    '4px',
    padding:         '16px 20px',
    margin:          '0 0 16px',
  },
  summaryHeading: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '13px',
    fontWeight: '600',
    margin:     '0 0 6px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  summaryText: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '14px',
    lineHeight: '1.6',
    margin:     '0',
  },
  affectedSection: {
    backgroundColor: EMAIL_THEME.colors.background,
    border:          `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius:    '4px',
    padding:         '12px 16px',
    margin:          '0 0 16px',
  },
  affectedLabel: {
    color:      EMAIL_THEME.colors.textSecondary,
    fontSize:   '12px',
    fontWeight: '600',
    margin:     '0 0 4px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  affectedText: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '14px',
    lineHeight: '1.5',
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
