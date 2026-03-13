import * as React from 'react';
import { Section, Text, Link, Hr, Row, Column } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface PlanDowngradedEmailProps {
  userName: string;
  orgName: string;
  previousPlanName: string;  // e.g. "Startup"
  reactivateUrl: string;
  dashboardUrl: string;
}

export function PlanDowngradedEmail({
  userName,
  orgName,
  previousPlanName,
  reactivateUrl,
  dashboardUrl,
}: PlanDowngradedEmailProps) {
  return (
    <BaseLayout preheaderText={`${orgName} has been moved to the free tier — reactivate anytime`}>
      <Text style={styles.greeting}>Hi {userName},</Text>

      <Text style={styles.body}>
        The 7-day grace period for <strong>{orgName}</strong>&apos;s{' '}
        <strong>{previousPlanName}</strong> subscription has ended. Your account has been moved
        to the free Regulator tier.
      </Text>

      {/* Status card */}
      <Section style={styles.statusCard}>
        <Row>
          <Column style={styles.statusCol}>
            <Text style={styles.statusLabel}>Previous plan</Text>
            <Text style={styles.statusValuePrev}>{previousPlanName}</Text>
          </Column>
          <Column style={styles.arrowCol}>
            <Text style={styles.arrow}>→</Text>
          </Column>
          <Column style={styles.statusCol}>
            <Text style={styles.statusLabel}>Current plan</Text>
            <Text style={styles.statusValueNew}>Free (Regulator)</Text>
          </Column>
        </Row>
      </Section>

      <Hr style={styles.divider} />

      <Text style={styles.subheading}>What this means for your account</Text>

      <ul style={styles.list}>
        <li style={styles.listItem}>
          <strong>Data preserved</strong> — all your documents, compliance history, and settings
          are still there
        </li>
        <li style={styles.listItem}>
          <strong>Limited queries</strong> — compliance queries are now capped at the free-tier limit
        </li>
        <li style={styles.listItem}>
          <strong>Premium features locked</strong> — AI checklists, gap analysis, and document
          repository require a paid plan
        </li>
      </ul>

      <Text style={styles.body}>
        Ready to reactivate? It takes less than 2 minutes and your previous settings are restored
        immediately.
      </Text>

      <Section style={styles.ctaSection}>
        <EmailButton href={reactivateUrl} variant="primary">
          Reactivate Now
        </EmailButton>
      </Section>

      <Text style={styles.note}>
        Questions about your account?{' '}
        <Link href={dashboardUrl} style={styles.link}>
          Log in to your dashboard
        </Link>{' '}
        or reply to this email — we&apos;re happy to help.
      </Text>
    </BaseLayout>
  );
}

export function getPlanDowngradedSubject(previousPlanName: string): string {
  return `Your ${previousPlanName} plan has ended — SheriaBot`;
}

const styles: Record<string, React.CSSProperties> = {
  greeting: {
    color: EMAIL_THEME.colors.text,
    fontSize: '16px',
    fontWeight: '600',
    margin: '0 0 16px',
  },
  body: {
    color: EMAIL_THEME.colors.text,
    fontSize: '15px',
    lineHeight: '1.6',
    margin: '0 0 16px',
  },
  statusCard: {
    backgroundColor: EMAIL_THEME.colors.background,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius: '6px',
    padding: '20px',
    margin: '0 0 20px',
  },
  statusCol: {
    textAlign: 'center',
    width: '42%',
  },
  arrowCol: {
    textAlign: 'center',
    width: '16%',
  },
  statusLabel: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '11px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    margin: '0 0 4px',
  },
  statusValuePrev: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '16px',
    fontWeight: '700',
    margin: '0',
    textDecoration: 'line-through',
  },
  statusValueNew: {
    color: EMAIL_THEME.colors.text,
    fontSize: '16px',
    fontWeight: '700',
    margin: '0',
  },
  arrow: {
    color: EMAIL_THEME.colors.textMuted,
    fontSize: '24px',
    margin: '12px 0 0',
  },
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    margin: '20px 0',
  },
  subheading: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    fontWeight: '700',
    margin: '0 0 10px',
  },
  list: {
    margin: '0 0 20px',
    paddingLeft: '20px',
  },
  listItem: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    lineHeight: '1.7',
    marginBottom: '4px',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '24px 0',
  },
  note: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    lineHeight: '1.5',
    textAlign: 'center',
    margin: '0',
  },
  link: {
    color: EMAIL_THEME.colors.primary,
    textDecoration: 'none',
  },
};
