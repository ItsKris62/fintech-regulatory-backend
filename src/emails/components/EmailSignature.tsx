import * as React from 'react';
import { Section, Hr, Text, Link } from '@react-email/components';
import { EMAIL_THEME, APP_NAME, SUPPORT_EMAIL, CURRENT_YEAR, SHERIABOT_URL } from '../theme';

export interface EmailSignatureProps {
  /**
   * @deprecated For transactional templates only. Marketing/bulk sends MUST use
   * MarketingBaseLayout, which generates a token-signed unsubscribe URL. The
   * email-based unsubscribe URL produced when this is true is insecure (anyone
   * who knows the email can unsubscribe anyone) and is RFC 8058 non-compliant.
   * Setting this to true on a marketing-context email may result in DPA 2019
   * compliance failures.
   */
  showUnsubscribe?: boolean;
  recipientEmail?: string;
}

/**
 * Reusable email footer / signature block.
 *
 * Renders:
 *   - Horizontal divider
 *   - Brand tagline
 *   - Contact info (support email)
 *   - Optional unsubscribe link
 *   - Copyright notice
 *
 * Used by BaseLayout so all 16 templates inherit it automatically.
 * Can also be imported directly into one-off transactional emails.
 */
export function EmailSignature({ showUnsubscribe = false, recipientEmail }: EmailSignatureProps) {
  return (
    <Section style={styles.footerSection}>
      <Text style={styles.brand}>
        {APP_NAME} — AI-Powered Regulatory Compliance for Kenya&apos;s Fintech & Financial Sector
      </Text>

      <Text style={styles.contact}>
        Nairobi, Kenya &nbsp;&bull;&nbsp;{' '}
        <Link href={`mailto:${SUPPORT_EMAIL}`} style={styles.link}>
          {SUPPORT_EMAIL}
        </Link>
        &nbsp;&bull;&nbsp;{' '}
        <Link href={SHERIABOT_URL} style={styles.link}>
          sheriabot.com
        </Link>
      </Text>

      {showUnsubscribe && recipientEmail && (
        <Text style={styles.contact}>
          <Link
            href={`${SHERIABOT_URL}/unsubscribe?email=${encodeURIComponent(recipientEmail)}`}
            style={styles.link}
          >
            Unsubscribe
          </Link>{' '}
          from notification emails.
        </Text>
      )}

      <Text style={styles.copyright}>
        &copy; {CURRENT_YEAR} {APP_NAME}. All rights reserved.
      </Text>
    </Section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  footerSection: {
    padding: '16px 0 24px',
    textAlign: 'center',
  },
  brand: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '12px',
    fontWeight: '500',
    textAlign: 'center',
    margin: '8px 0 4px',
  },
  contact: {
    color: EMAIL_THEME.colors.textMuted,
    fontSize: '11px',
    textAlign: 'center',
    margin: '4px 0',
  },
  link: {
    color: EMAIL_THEME.colors.primary,
    fontWeight: '500',
    textDecoration: 'none',
  },
  copyright: {
    color: EMAIL_THEME.colors.textMuted,
    fontSize: '11px',
    textAlign: 'center',
    margin: '8px 0 0',
  },
};
