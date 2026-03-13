import * as React from 'react';
import { Section, Text, Link, Hr } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface SubscriptionCancelledEmailProps {
  userName: string;
  orgName: string;
  planName: string;           // Plan being cancelled
  gracePeriodEndsAt: string;  // ISO date string — full access until this date
  reactivateUrl: string;      // Link to restart checkout
  dashboardUrl: string;
}

export function SubscriptionCancelledEmail({
  userName,
  orgName,
  planName,
  gracePeriodEndsAt,
  reactivateUrl,
  dashboardUrl,
}: SubscriptionCancelledEmailProps) {
  const graceDate = new Date(gracePeriodEndsAt).toLocaleDateString('en-KE', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  return (
    <BaseLayout preheaderText={`Your ${planName} subscription has been cancelled — you have 7 days of access remaining`}>
      <Text style={styles.greeting}>Hi {userName},</Text>

      <Text style={styles.body}>
        We&apos;ve confirmed the cancellation of the SheriaBot <strong>{planName}</strong>{' '}
        subscription for <strong>{orgName}</strong>.
      </Text>

      {/* Grace period notice */}
      <Section style={styles.graceCard}>
        <Text style={styles.graceHeading}>You still have full access</Text>
        <Hr style={styles.divider} />
        <Text style={styles.graceBody}>
          As a courtesy, you retain full <strong>{planName}</strong> access until{' '}
          <strong>{graceDate}</strong> — 7 days from today. After that, your account
          automatically reverts to the free tier with no data loss.
        </Text>
      </Section>

      <Text style={styles.body}>
        Changed your mind? You can reactivate your subscription at any time before {graceDate}{' '}
        and pick up right where you left off.
      </Text>

      <Section style={styles.ctaSection}>
        <EmailButton href={reactivateUrl} variant="primary">
          Reactivate Subscription
        </EmailButton>
      </Section>

      <Text style={styles.subtext}>
        What happens after {graceDate}:
      </Text>
      <ul style={styles.list}>
        <li style={styles.listItem}>Your account reverts to the free Regulator tier</li>
        <li style={styles.listItem}>All your data, documents, and history are preserved</li>
        <li style={styles.listItem}>You can resubscribe and regain premium access at any time</li>
      </ul>

      <Text style={styles.note}>
        Still have questions?{' '}
        <Link href={dashboardUrl} style={styles.link}>
          Visit your dashboard
        </Link>{' '}
        or reply to this email — we&apos;re always happy to help.
      </Text>
    </BaseLayout>
  );
}

export function getSubscriptionCancelledSubject(planName: string): string {
  return `Your ${planName} subscription has been cancelled — SheriaBot`;
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
  graceCard: {
    backgroundColor: EMAIL_THEME.colors.warningBg,
    border: `1px solid ${EMAIL_THEME.colors.warning}50`,
    borderRadius: '6px',
    padding: '20px',
    margin: '0 0 20px',
  },
  graceHeading: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    fontWeight: '700',
    margin: '0 0 4px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    margin: '8px 0 12px',
  },
  graceBody: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    lineHeight: '1.6',
    margin: '0',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '24px 0',
  },
  subtext: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    fontWeight: '600',
    margin: '0 0 8px',
  },
  list: {
    margin: '0 0 20px',
    paddingLeft: '20px',
  },
  listItem: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '14px',
    lineHeight: '1.7',
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
