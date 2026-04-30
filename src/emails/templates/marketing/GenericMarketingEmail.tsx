/**
 * GenericMarketingEmail
 *
 * Admin-fillable template for ad-hoc sends that don't fit the other 6 templates.
 * All copy is supplied via variables — no rich text, no HTML in body paragraphs.
 *
 * SECURITY: bodyParagraphs are plain text only. HTML characters are escaped
 * as defense-in-depth (React's JSX already escapes by default, but we apply
 * an explicit escaper to make the intent clear and guard against future
 * refactors that might use dangerouslySetInnerHTML).
 *
 * Subject suggestion: set by the admin when creating the campaign.
 */

import * as React from 'react';
import { Text, Section, Hr } from '@react-email/components';
import { MarketingBaseLayout } from './MarketingBaseLayout';
import { MarketingEmailButton } from '../../components/MarketingEmailButton';
import { EMAIL_THEME } from '../../theme';

export interface GenericMarketingEmailProps {
  recipientFirstName?: string;
  headline: string;
  bodyParagraphs: string[];
  ctaUrl?: string;
  ctaText?: string;
  unsubscribeUrl: string;
}

/**
 * Escape HTML special characters in plain-text strings.
 * Defense-in-depth: React JSX already escapes by default.
 * This makes the intent explicit and guards against future refactors.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default function GenericMarketingEmail({
  recipientFirstName,
  headline,
  bodyParagraphs,
  ctaUrl,
  ctaText,
  unsubscribeUrl,
}: GenericMarketingEmailProps) {
  const greeting = recipientFirstName ? `Hi ${recipientFirstName},` : 'Hi there,';
  const hasCta = ctaUrl && ctaText;

  return (
    <MarketingBaseLayout
      preheaderText={escapeHtml(headline)}
      unsubscribeUrl={unsubscribeUrl}
      campaignName="SheriaBot"
    >
      {/* Greeting */}
      <Text style={styles.greeting}>{greeting}</Text>

      {/* Headline */}
      <Text style={styles.headline}>{escapeHtml(headline)}</Text>

      <Hr style={styles.divider} />

      {/* Body paragraphs — plain text only, no HTML */}
      <Section style={styles.bodySection}>
        {bodyParagraphs.map((paragraph, index) => (
          <Text key={index} style={styles.body}>
            {escapeHtml(paragraph)}
          </Text>
        ))}
      </Section>

      {/* Optional CTA */}
      {hasCta && (
        <MarketingEmailButton href={ctaUrl} variant="primary">
          {escapeHtml(ctaText)}
        </MarketingEmailButton>
      )}

      <Hr style={styles.divider} />

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
  headline: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '22px',
    fontWeight: '700',
    lineHeight: '1.3',
    margin:     '0 0 16px',
  },
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    margin:      '20px 0',
  },
  bodySection: {
    margin: '0 0 8px',
  },
  body: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '15px',
    lineHeight: '1.6',
    margin:     '0 0 14px',
  },
  signoff: {
    color:      EMAIL_THEME.colors.textSecondary,
    fontSize:   '14px',
    lineHeight: '1.5',
    margin:     '16px 0 0',
  },
};
