import * as React from 'react';
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Img,
  Text,
  Link,
  Hr,
} from '@react-email/components';
import {
  EMAIL_THEME,
  LOGO_URL,
  APP_NAME,
  SHERIABOT_URL,
  CURRENT_YEAR,
} from '../../theme';

// ---------------------------------------------------------------------------
// Marketing-specific color palette
// Defined inline — does NOT extend or modify EMAIL_THEME (sacred).
// ---------------------------------------------------------------------------

const MARKETING_COLORS = {
  heroBand:        '#15803D',   // Green-700 — matches brand primary
  heroBandHeight:  '120px',
  cardBackground:  '#FFFFFF',
  bodyBackground:  '#F8F9FA',   // Same as transactional BaseLayout for deliverability
  footerText:      '#9CA3AF',
  footerLink:      '#15803D',
  divider:         '#E5E7EB',
} as const;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MarketingBaseLayoutProps {
  preheaderText: string;
  children: React.ReactNode;
  /** Already-tokenized unsubscribe URL — caller responsibility. REQUIRED. */
  unsubscribeUrl: string;
  /** Displayed near the unsubscribe link for transparency. */
  recipientEmail?: string;
  /** Displayed in footer: "You received this as part of: {campaignName}" */
  campaignName?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MarketingBaseLayout({
  preheaderText,
  children,
  unsubscribeUrl,
  recipientEmail,
  campaignName,
}: MarketingBaseLayoutProps) {
  // Guard: a marketing email without an unsubscribe link is a legal violation.
  if (!unsubscribeUrl) {
    throw new Error(
      'MarketingBaseLayout requires a tokenized unsubscribeUrl. ' +
      'Marketing sends without unsubscribe links are RFC 8058 / DPA 2019 non-compliant.',
    );
  }

  return (
    <Html lang="en">
      <Head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <style>{`
          * { box-sizing: border-box; }
          body { margin: 0; padding: 0; }
          a { color: ${MARKETING_COLORS.heroBand}; }
        `}</style>
      </Head>
      <Preview>{preheaderText}</Preview>

      <Body style={styles.body}>

        {/* ── Hero band ─────────────────────────────────────────────────── */}
        <Container style={styles.outerContainer}>
          <Section style={styles.heroBand}>
            <div style={styles.logoBadge}>
              <Img
                src={LOGO_URL}
                alt={APP_NAME}
                width="220"
                height="auto"
                style={styles.logo}
              />
            </div>
          </Section>

          {/* ── Card body ───────────────────────────────────────────────── */}
          <Section style={styles.card}>
            {children}
          </Section>

          {/* ── Footer ──────────────────────────────────────────────────── */}
          <Section style={styles.footer}>
            <Hr style={styles.divider} />

            {campaignName && (
              <Text style={styles.footerText}>
                You&apos;re receiving this email as part of &ldquo;{campaignName}&rdquo;.
              </Text>
            )}

            <Text style={styles.footerLinks}>
              {recipientEmail && (
                <>
                  <span style={styles.footerMuted}>{recipientEmail}</span>
                  <span style={styles.footerSep}> | </span>
                </>
              )}
              <Link href={unsubscribeUrl} style={styles.footerLink}>
                Unsubscribe
              </Link>
              <span style={styles.footerSep}> | </span>
              <Link href={SHERIABOT_URL} style={styles.footerLink}>
                View in browser
              </Link>
            </Text>

            <Text style={styles.footerBrand}>
              {APP_NAME} &middot; Nairobi, Kenya
            </Text>
            <Text style={styles.footerCopyright}>
              {CURRENT_YEAR} &copy; All rights reserved
            </Text>
          </Section>
        </Container>

      </Body>
    </Html>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  body: {
    backgroundColor: MARKETING_COLORS.bodyBackground,
    fontFamily:      EMAIL_THEME.fonts.body,
    margin:          0,
    padding:         '24px 0',
  },
  outerContainer: {
    maxWidth: EMAIL_THEME.spacing.containerWidth,
    margin:   '0 auto',
    padding:  '0 16px',
  },
  heroBand: {
    backgroundColor: '#0F172A',
    borderTop:       `4px solid ${EMAIL_THEME.colors.primary}`,
    borderRadius:    '12px 12px 0 0',
    textAlign:       'center',
    padding:         '24px 32px',
  },
  logoBadge: {
    backgroundColor: '#FFFFFF',
    borderRadius:    '8px',
    padding:         '12px 24px',
    display:         'inline-block',
    margin:          '0 auto',
    boxShadow:       '0 4px 12px rgba(0, 0, 0, 0.15)',
  },
  logo: {
    maxWidth: '220px',
    width:    '100%',
    height:   'auto',
    display:  'block',
    margin:   '0 auto',
  },
  card: {
    backgroundColor: MARKETING_COLORS.cardBackground,
    padding:         EMAIL_THEME.spacing.containerPadding,
    borderLeft:      `1px solid ${EMAIL_THEME.colors.border}`,
    borderRight:     `1px solid ${EMAIL_THEME.colors.border}`,
  },
  footer: {
    backgroundColor: MARKETING_COLORS.cardBackground,
    padding:         '0 40px 24px',
    borderLeft:      `1px solid ${EMAIL_THEME.colors.border}`,
    borderRight:     `1px solid ${EMAIL_THEME.colors.border}`,
    borderBottom:    `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius:    '0 0 8px 8px',
  },
  divider: {
    borderColor: MARKETING_COLORS.divider,
    margin:      '0 0 16px',
  },
  footerText: {
    color:     EMAIL_THEME.colors.textMuted,
    fontSize:  '11px',
    textAlign: 'center',
    margin:    '0 0 8px',
  },
  footerLinks: {
    color:     EMAIL_THEME.colors.textMuted,
    fontSize:  '11px',
    textAlign: 'center',
    margin:    '0 0 8px',
  },
  footerMuted: {
    color:    EMAIL_THEME.colors.textMuted,
    fontSize: '11px',
  },
  footerSep: {
    color:    EMAIL_THEME.colors.textMuted,
    fontSize: '11px',
    padding:  '0 4px',
  },
  footerLink: {
    color:          MARKETING_COLORS.footerLink,
    fontSize:       '11px',
    textDecoration: 'none',
  },
  footerBrand: {
    color:     EMAIL_THEME.colors.textMuted,
    fontSize:  '11px',
    textAlign: 'center',
    margin:    '0 0 2px',
  },
  footerCopyright: {
    color:     EMAIL_THEME.colors.textMuted,
    fontSize:  '11px',
    textAlign: 'center',
    margin:    '0',
  },
};
