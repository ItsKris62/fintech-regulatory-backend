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
import { EMAIL_THEME, LOGO_URL, APP_NAME } from '../theme';
import { EmailSignature } from './EmailSignature';

export interface BaseLayoutProps {
  preheaderText: string;
  children: React.ReactNode;
  showUnsubscribe?: boolean;
  recipientEmail?: string;
}

export function BaseLayout({
  preheaderText,
  children,
  showUnsubscribe = false,
  recipientEmail,
}: BaseLayoutProps) {
  return (
    <Html lang="en">
      <Head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <style>{`
          * { box-sizing: border-box; }
          body { margin: 0; padding: 0; background-color: ${EMAIL_THEME.colors.background}; }
          a { color: ${EMAIL_THEME.colors.primary}; }
        `}</style>
      </Head>
      <Preview>{preheaderText}</Preview>
      <Body style={styles.body}>
        <Container style={styles.outerContainer}>
          {/* Header */}
          <Section style={styles.header}>
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

          {/* Card Content */}
          <Section style={styles.card}>
            {children}
          </Section>

          {/* Footer */}
          <Section style={styles.footerContainer}>
            <EmailSignature
              showUnsubscribe={showUnsubscribe}
              recipientEmail={recipientEmail}
            />
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: {
    backgroundColor: EMAIL_THEME.colors.background,
    fontFamily: EMAIL_THEME.fonts.body,
    margin: 0,
    padding: '24px 0',
  },
  outerContainer: {
    maxWidth: EMAIL_THEME.spacing.containerWidth,
    margin: '0 auto',
    padding: '0 16px',
  },
  header: {
    backgroundColor: EMAIL_THEME.colors.headerBackground,
    borderTop: `4px solid ${EMAIL_THEME.colors.primary}`,
    borderRadius: '12px 12px 0 0',
    padding: '24px 32px',
    textAlign: 'center',
  },
  logoBadge: {
    backgroundColor: '#FFFFFF',
    borderRadius: '8px',
    padding: '12px 24px',
    display: 'inline-block',
    margin: '0 auto',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
  },
  logo: {
    maxWidth: '220px',
    width: '100%',
    height: 'auto',
    display: 'block',
    margin: '0 auto',
  },
  card: {
    backgroundColor: EMAIL_THEME.colors.cardBackground,
    padding: '36px 40px',
    borderLeft: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRight: `1px solid ${EMAIL_THEME.colors.border}`,
    borderBottom: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius: '0 0 12px 12px',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)',
  },
  footerContainer: {
    padding: '24px 16px 0',
  },
};
