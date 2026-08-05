import * as React from 'react';
import { Section, Text, Link, Img } from '@react-email/components';
import { EMAIL_THEME, APP_NAME, SUPPORT_EMAIL, CURRENT_YEAR, SHERIABOT_URL, EMAIL_SIGNATURE_LOGO_URL } from '../theme';

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
 *   - New official SheriaBot Email Signature Banner (R2 served)
 *   - Contact info & support email
 *   - Optional unsubscribe link
 *   - Copyright notice
 *
 * Used by BaseLayout so all 16 templates inherit it automatically.
 */
export function EmailSignature({ showUnsubscribe = false, recipientEmail }: EmailSignatureProps) {
  return (
    <Section style={styles.footerSection}>
      <div style={styles.signatureBadge}>
        <Img
          src={EMAIL_SIGNATURE_LOGO_URL}
          alt={`${APP_NAME} — Your Legal Tech Assistant`}
          width="480"
          height="auto"
          style={styles.signatureImg}
        />
      </div>

      <Text style={styles.contact}>
        Support:{' '}
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
    padding: '24px 0 32px',
    textAlign: 'center',
  },
  signatureBadge: {
    margin: '0 auto 16px',
    textAlign: 'center',
  },
  signatureImg: {
    maxWidth: '100%',
    width: '480px',
    height: 'auto',
    display: 'block',
    margin: '0 auto',
    borderRadius: '8px',
  },
  contact: {
    color: EMAIL_THEME.colors.textMuted,
    fontSize: '12px',
    textAlign: 'center',
    margin: '8px 0 4px',
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
