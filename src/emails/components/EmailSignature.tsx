import * as React from 'react';
import { Section, Text, Link, Hr } from '@react-email/components';
import {
  EMAIL_THEME,
  SHERIA_EMAIL_PALETTE,
  APP_NAME,
  SUPPORT_EMAIL,
  CURRENT_YEAR,
  SHERIABOT_URL,
  REGISTERED_OFFICE,
  DATA_PROTECTION_DISCLAIMER,
  LEGAL_DISCLAIMER,
} from '../theme';

export interface EmailSignatureProps {
  /**
   * @deprecated For transactional templates only. Marketing/bulk sends MUST use
   * MarketingBaseLayout, which generates a token-signed unsubscribe URL.
   */
  showUnsubscribe?: boolean;
  recipientEmail?: string;
  unsubscribeUrl?: string;
}

/**
 * Modernized Institutional Email Signature & Footer Block
 *
 * Lightweight, email-safe HTML lockup replacing raster images with:
 *   - Institutional RegTech wordmark & credentials
 *   - Support, notification preferences, & website links
 *   - Kenya DPA 2019 data sovereignty certification notice
 *   - Mandatory statutory non-counsel legal disclaimer
 *   - Registered business address in Nairobi, Kenya
 */
export function EmailSignature({
  showUnsubscribe = false,
  recipientEmail,
  unsubscribeUrl,
}: EmailSignatureProps) {
  const unsubLink =
    unsubscribeUrl ||
    (recipientEmail
      ? `${SHERIABOT_URL}/unsubscribe?email=${encodeURIComponent(recipientEmail)}`
      : `${SHERIABOT_URL}/settings/notifications`);

  return (
    <Section style={styles.footerSection}>
      {/* Subtle Institutional Brand Line */}
      <table border={0} cellPadding={0} cellSpacing={0} width="100%" style={{ marginBottom: '16px' }}>
        <tbody>
          <tr>
            <td align="center">
              <span style={styles.brandTitle}>
                {APP_NAME} <span style={{ color: SHERIA_EMAIL_PALETTE.brand.primary }}>RegTech</span>
              </span>
              <span style={styles.brandSubtitle}>
                Kenya Regulatory Intelligence &amp; Compliance Automation
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Support & Quick Links */}
      <Text style={styles.contactLine}>
        Support:{' '}
        <Link href={`mailto:${SUPPORT_EMAIL}`} style={styles.link}>
          {SUPPORT_EMAIL}
        </Link>
        {' '}&bull;{' '}
        <Link href={SHERIABOT_URL} style={styles.link}>
          sheriabot.com
        </Link>
        {' '}&bull;{' '}
        <Link href={`${SHERIABOT_URL}/legal/privacy`} style={styles.link}>
          Privacy
        </Link>
        {' '}&bull;{' '}
        <Link href={`${SHERIABOT_URL}/legal/terms`} style={styles.link}>
          Terms
        </Link>
      </Text>

      {/* Unsubscribe / Preferences */}
      {showUnsubscribe && (
        <Text style={styles.unsubscribeText}>
          <Link href={unsubLink} style={styles.link}>
            Manage notification preferences
          </Link>
          {' '}or{' '}
          <Link href={unsubLink} style={styles.link}>
            unsubscribe
          </Link>
          {' '}from this alert feed.
        </Text>
      )}

      <Hr style={styles.divider} />

      {/* Data Sovereignty & Regulatory Compliance Notice */}
      <Text style={styles.complianceNotice}>
        <strong>Data Sovereignty &amp; Privacy:</strong> {DATA_PROTECTION_DISCLAIMER}
      </Text>

      {/* Mandatory Statutory Legal Disclaimer */}
      <Text style={styles.legalDisclaimer}>
        <em>Disclaimer:</em> {LEGAL_DISCLAIMER}
      </Text>

      {/* Physical Registered Address & Copyright */}
      <Text style={styles.officeAddress}>
        {APP_NAME} AI RegTech Ltd &bull; {REGISTERED_OFFICE}
      </Text>
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
  brandTitle: {
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '14px',
    fontWeight: '800',
    color: SHERIA_EMAIL_PALETTE.text.primary,
    letterSpacing: '-0.01em',
    display: 'block',
  },
  brandSubtitle: {
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '11px',
    fontWeight: '500',
    color: SHERIA_EMAIL_PALETTE.text.muted,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    display: 'block',
    marginTop: '2px',
  },
  contactLine: {
    color: SHERIA_EMAIL_PALETTE.text.muted,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '12px',
    textAlign: 'center',
    margin: '10px 0 6px',
  },
  unsubscribeText: {
    color: SHERIA_EMAIL_PALETTE.text.faint,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '11px',
    textAlign: 'center',
    margin: '6px 0 10px',
  },
  link: {
    color: SHERIA_EMAIL_PALETTE.brand.primary,
    fontWeight: '600',
    textDecoration: 'none',
  },
  divider: {
    borderColor: SHERIA_EMAIL_PALETTE.surfaces.borderLight,
    margin: '16px auto',
    maxWidth: '480px',
  },
  complianceNotice: {
    color: SHERIA_EMAIL_PALETTE.text.muted,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '11px',
    lineHeight: '16px',
    textAlign: 'center',
    margin: '0 0 6px',
  },
  legalDisclaimer: {
    color: SHERIA_EMAIL_PALETTE.text.faint,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '10px',
    lineHeight: '15px',
    textAlign: 'center',
    margin: '0 0 8px',
  },
  officeAddress: {
    color: SHERIA_EMAIL_PALETTE.text.faint,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '10px',
    textAlign: 'center',
    margin: '0 0 4px',
  },
  copyright: {
    color: SHERIA_EMAIL_PALETTE.text.faint,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '10px',
    textAlign: 'center',
    margin: '0',
  },
};
