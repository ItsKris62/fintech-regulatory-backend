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
          body { margin: 0; padding: 0; }
          a { color: ${EMAIL_THEME.colors.primary}; }
        `}</style>
      </Head>
      <Preview>{preheaderText}</Preview>
      <Body style={styles.body}>
        {/* Header */}
        <Container style={styles.headerContainer}>
          <Section style={styles.header}>
            <Img
              src={LOGO_URL}
              alt={APP_NAME}
              width="140"
              height="auto"
              style={styles.logo}
            />
          </Section>
        </Container>

        {/* Card Content */}
        <Container style={styles.container}>
          <Section style={styles.card}>
            {children}
          </Section>
        </Container>

        {/* Footer */}
        <Container style={styles.footerContainer}>
          <EmailSignature
            showUnsubscribe={showUnsubscribe}
            recipientEmail={recipientEmail}
          />
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
    padding: 0,
  },
  headerContainer: {
    maxWidth: EMAIL_THEME.spacing.containerWidth,
    margin: '0 auto',
    padding: '24px 20px 0',
  },
  header: {
    backgroundColor: EMAIL_THEME.colors.primary,
    borderRadius: '8px 8px 0 0',
    padding: '20px 40px',
    textAlign: 'center',
  },
  logo: {
    maxWidth: '160px',
    height: 'auto',
  },
  container: {
    maxWidth: EMAIL_THEME.spacing.containerWidth,
    margin: '0 auto',
    padding: '0 20px',
  },
  card: {
    backgroundColor: EMAIL_THEME.colors.cardBackground,
    padding: '32px 40px',
    borderLeft: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRight: `1px solid ${EMAIL_THEME.colors.border}`,
  },
  footerContainer: {
    maxWidth: EMAIL_THEME.spacing.containerWidth,
    margin: '0 auto',
    padding: '0 20px 24px',
  },
};
