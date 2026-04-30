/**
 * ProductLaunchEmail
 *
 * Sent when a major new feature ships.
 * E.g., "Regulatory Alerts is now live."
 *
 * Subject suggestion:
 *   "{featureName} is now live in SheriaBot"
 */

import * as React from 'react';
import { Text, Section, Hr } from '@react-email/components';
import { MarketingBaseLayout } from './MarketingBaseLayout';
import { MarketingEmailButton } from '../../components/MarketingEmailButton';
import { EMAIL_THEME } from '../../theme';

export interface ProductLaunchEmailProps {
  recipientFirstName?: string;
  featureName: string;
  featureTagline: string;
  ctaUrl: string;
  ctaText: string;
  whatsNew: string[];
  unsubscribeUrl: string;
}

export default function ProductLaunchEmail({
  recipientFirstName,
  featureName,
  featureTagline,
  ctaUrl,
  ctaText,
  whatsNew,
  unsubscribeUrl,
}: ProductLaunchEmailProps) {
  const greeting = recipientFirstName ? `Hi ${recipientFirstName},` : 'Hi there,';

  return (
    <MarketingBaseLayout
      preheaderText={`${featureName} is now live — ${featureTagline}`}
      unsubscribeUrl={unsubscribeUrl}
      campaignName="SheriaBot Product Updates"
    >
      {/* Greeting */}
      <Text style={styles.greeting}>{greeting}</Text>

      {/* Feature launch badge */}
      <Section style={styles.launchBadge}>
        <Text style={styles.launchBadgeText}>NEW FEATURE</Text>
      </Section>

      {/* Hero: feature name + tagline */}
      <Text style={styles.headline}>{featureName}</Text>
      <Text style={styles.tagline}>{featureTagline}</Text>

      <Hr style={styles.divider} />

      {/* What's new section */}
      <Text style={styles.sectionHeading}>What&apos;s new:</Text>
      <Section style={styles.whatsNewSection}>
        {whatsNew.map((item, index) => (
          <Text key={index} style={styles.bulletItem}>
            ✓ {item}
          </Text>
        ))}
      </Section>

      {/* CTA */}
      <MarketingEmailButton href={ctaUrl} variant="primary">
        {ctaText}
      </MarketingEmailButton>

      <Hr style={styles.divider} />

      <Text style={styles.footer}>
        This feature is available to all active SheriaBot accounts.
        If you have feedback, reply to this email — we read every response.
      </Text>

      <Text style={styles.signoff}>
        — The SheriaBot Team
      </Text>
    </MarketingBaseLayout>
  );
}

const styles: Record<string, React.CSSProperties> = {
  greeting: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '16px',
    lineHeight: '1.5',
    margin:     '0 0 16px',
  },
  launchBadge: {
    margin: '0 0 12px',
  },
  launchBadgeText: {
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
  headline: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '26px',
    fontWeight: '700',
    lineHeight: '1.3',
    margin:     '0 0 8px',
  },
  tagline: {
    color:      EMAIL_THEME.colors.textSecondary,
    fontSize:   '16px',
    lineHeight: '1.5',
    margin:     '0 0 16px',
  },
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    margin:      '20px 0',
  },
  sectionHeading: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '15px',
    fontWeight: '600',
    margin:     '0 0 12px',
  },
  whatsNewSection: {
    backgroundColor: EMAIL_THEME.colors.successBg,
    borderLeft:      `4px solid ${EMAIL_THEME.colors.primary}`,
    borderRadius:    '4px',
    padding:         '16px 20px',
    margin:          '0 0 16px',
  },
  bulletItem: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '14px',
    lineHeight: '1.6',
    margin:     '0 0 6px',
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
