import * as React from 'react';
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Img,
} from '@react-email/components';
import { EMAIL_THEME, SHERIA_EMAIL_PALETTE, LOGO_URL, APP_NAME } from '../theme';
import { EmailSignature } from './EmailSignature';

export interface BaseLayoutProps {
  preheaderText: string;
  children?: React.ReactNode;
  showUnsubscribe?: boolean;
  recipientEmail?: string;
  headerBadgeText?: string;
  unsubscribeUrl?: string;
}

/**
 * SheriaBot Master Email Layout Blueprint
 *
 * Provides:
 *   - Obsidian brand header with 3px Emerald top rule
 *   - Zero-width whitespace hack protecting mailbox preview snippets
 *   - Dark mode and mobile-responsive viewport meta tags
 *   - Seamless white card container with subtle Zinc border
 *   - Institutional footer with Kenya DPA 2019 data sovereignty disclaimers
 */
export function BaseLayout({
  preheaderText,
  children,
  showUnsubscribe = false,
  recipientEmail,
  headerBadgeText = 'KENYA REGTECH',
  unsubscribeUrl,
}: BaseLayoutProps) {
  // 150+ invisible non-breaking spaces to isolate preheader in mailbox lists
  const whitespacePadding =
    ' \u200C \u00A0 \u2007 \u00AD \u200C \u00A0 \u2007 \u00AD \u200C \u00A0 \u2007 \u00AD \u200C \u00A0 \u2007 \u00AD \u200C \u00A0 \u2007 \u00AD \u200C \u00A0 \u2007 \u00AD \u200C \u00A0 \u2007 \u00AD \u200C \u00A0 \u2007 \u00AD \u200C \u00A0 \u2007 \u00AD \u200C \u00A0 \u2007 \u00AD';

  return (
    <Html lang="en">
      <Head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <style>{`
          * { box-sizing: border-box; }
          body {
            margin: 0;
            padding: 0;
            width: 100% !important;
            background-color: ${SHERIA_EMAIL_PALETTE.surfaces.appBackground};
            -webkit-text-size-adjust: 100%;
            -ms-text-size-adjust: 100%;
          }
          table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
          img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
          a { color: ${SHERIA_EMAIL_PALETTE.brand.primary}; }
          
          @media only screen and (max-width: 600px) {
            .container-table { width: 100% !important; max-width: 100% !important; }
            .card-padding { padding: 24px 16px !important; }
            .header-padding { padding: 16px 20px !important; }
          }
          
          /* Dark mode overrides for supported clients */
          @media (prefers-color-scheme: dark) {
            body { background-color: #0A0A0A !important; }
            .email-card { background-color: #121214 !important; border-color: #27272A !important; }
            .dark-text { color: #FFFFFF !important; }
            .dark-muted { color: #A1A1AA !important; }
          }
        `}</style>
      </Head>

      <Preview>{preheaderText}</Preview>

      {/* Hidden zero-width whitespace snippet hack */}
      <div
        style={{
          display: 'none',
          maxHeight: '0px',
          overflow: 'hidden',
          fontSize: '1px',
          lineHeight: '1px',
          color: '#ffffff',
          opacity: 0,
        }}
      >
        {preheaderText}
        {whitespacePadding}
      </div>

      <Body style={styles.body}>
        <Container style={styles.outerContainer} className="container-table">
          {/* Master Obsidian Header */}
          <Section style={styles.header} className="header-padding">
            <table border={0} cellPadding={0} cellSpacing={0} width="100%">
              <tbody>
                <tr>
                  <td align="left" style={{ verticalAlign: 'middle' }}>
                    <div style={styles.brandLockup}>
                      {LOGO_URL ? (
                        <Img
                          src={LOGO_URL}
                          alt={APP_NAME}
                          width="140"
                          height="auto"
                          style={styles.logoImg}
                        />
                      ) : (
                        <span style={styles.brandText}>
                          Sheria<span style={{ color: SHERIA_EMAIL_PALETTE.brand.primary }}>Bot</span>
                        </span>
                      )}
                      <span style={styles.brandSubtext}>
                        Regulatory Intelligence Engine
                      </span>
                    </div>
                  </td>
                  {headerBadgeText && (
                    <td align="right" style={{ verticalAlign: 'middle' }}>
                      <span style={styles.headerBadge}>
                        {headerBadgeText}
                      </span>
                    </td>
                  )}
                </tr>
              </tbody>
            </table>
          </Section>

          {/* Card Content Shell */}
          <Section style={styles.card} className="card-padding email-card">
            {children}
          </Section>

          {/* Institutional Signature & Legal Footer */}
          <Section style={styles.footerContainer}>
            <EmailSignature
              showUnsubscribe={showUnsubscribe}
              recipientEmail={recipientEmail}
              unsubscribeUrl={unsubscribeUrl}
            />
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: {
    backgroundColor: SHERIA_EMAIL_PALETTE.surfaces.appBackground,
    fontFamily: EMAIL_THEME.fonts.sans,
    margin: 0,
    padding: '24px 0',
  },
  outerContainer: {
    maxWidth: EMAIL_THEME.spacing.containerWidth,
    margin: '0 auto',
    padding: '0 12px',
  },
  header: {
    backgroundColor: SHERIA_EMAIL_PALETTE.surfaces.headerDark,
    borderTop: `3px solid ${SHERIA_EMAIL_PALETTE.brand.primary}`,
    borderRadius: '10px 10px 0 0',
    padding: '20px 32px',
  },
  brandLockup: {
    display: 'inline-block',
  },
  logoImg: {
    maxWidth: '140px',
    width: '140px',
    height: 'auto',
    display: 'block',
  },
  brandText: {
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '20px',
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: '-0.02em',
    display: 'block',
  },
  brandSubtext: {
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '10px',
    fontWeight: '500',
    color: SHERIA_EMAIL_PALETTE.text.faint,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    display: 'block',
    marginTop: '2px',
  },
  headerBadge: {
    backgroundColor: SHERIA_EMAIL_PALETTE.brand.navy,
    color: '#93C5FD',
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '10px',
    fontWeight: '700',
    padding: '4px 8px',
    borderRadius: '4px',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    display: 'inline-block',
  },
  card: {
    backgroundColor: SHERIA_EMAIL_PALETTE.surfaces.cardBackground,
    padding: '32px 32px 24px',
    borderLeft: `1px solid ${SHERIA_EMAIL_PALETTE.surfaces.borderLight}`,
    borderRight: `1px solid ${SHERIA_EMAIL_PALETTE.surfaces.borderLight}`,
    borderBottom: `1px solid ${SHERIA_EMAIL_PALETTE.surfaces.borderLight}`,
    borderRadius: '0 0 10px 10px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.03)',
  },
  footerContainer: {
    padding: '0',
  },
};
