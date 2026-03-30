import * as React from 'react';
import { Section, Text, Link } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME, SHERIABOT_URL } from '../../theme';

export interface WelcomeEmailProps {
  userName: string;
  role: string;
  organizationName?: string;
  dashboardUrl: string;
}

function getRoleBody(role: string): string {
  const r = role.toUpperCase();
  if (r === 'REGULATOR') {
    return 'Your account has been verified and approved. As a regulator, you have access to policy generation tools and compliance oversight features.';
  }
  if (r === 'ENTERPRISE') {
    return 'Your email has been verified. Access comprehensive compliance tools designed for regulated financial institutions.';
  }
  return 'Your email has been verified. Start navigating Kenya\'s regulatory landscape with AI-powered compliance guidance.';
}

function getQuickStartItems(role: string): string[] {
  const r = role.toUpperCase();
  const base = ['Ask a compliance question', 'Browse regulatory documents'];
  if (r === 'REGULATOR') {
    return [...base, 'Generate a policy framework', 'Access oversight dashboards'];
  }
  if (r === 'ENTERPRISE') {
    return [...base, 'Generate a policy framework', 'Invite team members'];
  }
  return [...base, 'Generate a compliance checklist', 'Invite team members'];
}

export function WelcomeEmail({
  userName,
  role,
  organizationName,
  dashboardUrl,
}: WelcomeEmailProps) {
  const quickStartItems = getQuickStartItems(role);

  return (
    <BaseLayout preheaderText="Your SheriaBot account is ready. Here's how to get started.">
      <Text style={styles.heading}>Welcome aboard, {userName}!</Text>
      <Text style={styles.body}>{getRoleBody(role)}</Text>

      {organizationName && (
        <Text style={styles.orgNote}>
          You are registered under <strong>{organizationName}</strong>.
        </Text>
      )}

      <Section style={styles.quickStartSection}>
        <Text style={styles.quickStartTitle}>Quick Start</Text>
        {quickStartItems.map((item) => (
          <Text key={item} style={styles.quickStartItem}>
            &#9654; {item}
          </Text>
        ))}
      </Section>

      <Section style={styles.ctaSection}>
        <EmailButton href={dashboardUrl}>Go to Dashboard</EmailButton>
      </Section>

      <Text style={styles.footer}>
        Need help?{' '}
        <Link href={`${SHERIABOT_URL}/docs`} style={styles.link}>
          Visit our documentation
        </Link>{' '}
        or reply to this email.
      </Text>
    </BaseLayout>
  );
}

export const WelcomeEmailSubject = 'Welcome to SheriaBot — Your Compliance Journey Starts Here';

const styles: Record<string, React.CSSProperties> = {
  heading: {
    color: EMAIL_THEME.colors.primary,
    fontSize: '22px',
    fontWeight: '700',
    margin: '0 0 16px',
  },
  body: {
    color: EMAIL_THEME.colors.text,
    fontSize: '15px',
    lineHeight: '1.6',
    margin: '0 0 16px',
  },
  orgNote: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '14px',
    margin: '0 0 16px',
    fontStyle: 'italic',
  },
  quickStartSection: {
    backgroundColor: EMAIL_THEME.colors.background,
    borderRadius: '6px',
    padding: '16px 20px',
    margin: '16px 0 24px',
    borderLeft: `4px solid ${EMAIL_THEME.colors.accent}`,
  },
  quickStartTitle: {
    color: EMAIL_THEME.colors.primary,
    fontSize: '14px',
    fontWeight: '700',
    margin: '0 0 8px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  quickStartItem: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    margin: '4px 0',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '24px 0',
  },
  footer: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    margin: '16px 0 0',
    textAlign: 'center',
  },
  link: {
    color: EMAIL_THEME.colors.primary,
    textDecoration: 'none',
  },
};
