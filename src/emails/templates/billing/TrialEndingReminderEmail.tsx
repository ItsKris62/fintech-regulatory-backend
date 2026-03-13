import * as React from 'react';
import { Section, Text, Link } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface TrialEndingReminderEmailProps {
  userName: string;
  orgName: string;
  planName: string;       // e.g. "Startup"
  trialEndsAt: string;    // ISO date string
  daysRemaining: number;  // 7, 3, or 1
  billingPortalUrl: string;
  dashboardUrl: string;
}

export function TrialEndingReminderEmail({
  userName,
  orgName,
  planName,
  trialEndsAt,
  daysRemaining,
  billingPortalUrl,
  dashboardUrl,
}: TrialEndingReminderEmailProps) {
  const endDate = new Date(trialEndsAt).toLocaleDateString('en-KE', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const urgency = daysRemaining === 1 ? 'danger' : daysRemaining <= 3 ? 'warning' : 'info';
  const bannerColor =
    urgency === 'danger'  ? EMAIL_THEME.colors.danger  :
    urgency === 'warning' ? EMAIL_THEME.colors.warning  :
                            EMAIL_THEME.colors.primary;
  const bannerBg =
    urgency === 'danger'  ? EMAIL_THEME.colors.dangerBg  :
    urgency === 'warning' ? EMAIL_THEME.colors.warningBg :
                            EMAIL_THEME.colors.background;

  const dayLabel = daysRemaining === 1 ? '1 day' : `${daysRemaining} days`;

  return (
    <BaseLayout preheaderText={`Your ${planName} trial ends in ${dayLabel} — add payment details to continue`}>
      <Text style={styles.greeting}>Hi {userName},</Text>

      <Text style={styles.body}>
        Your free trial of the SheriaBot <strong>{planName}</strong> plan for{' '}
        <strong>{orgName}</strong> ends in <strong>{dayLabel}</strong>, on {endDate}.
      </Text>

      {/* Urgency banner */}
      <Section style={{ ...styles.urgencyBanner, backgroundColor: bannerBg, borderColor: bannerColor + '50' }}>
        <Text style={{ ...styles.urgencyText, color: bannerColor }}>
          {daysRemaining === 1
            ? 'Last day of your trial — add a payment method to avoid any interruption'
            : `${dayLabel} left in your trial`}
        </Text>
      </Section>

      <Text style={styles.body}>
        To continue using all the features you&apos;ve been enjoying — unlimited compliance queries,
        AI-generated checklists, and more — please add a payment method before your trial expires.
      </Text>

      <Text style={styles.body}>
        If you choose not to continue, your account will automatically revert to the free Regulator
        tier on {endDate}. No charge will ever be made without a valid payment method on file.
      </Text>

      <Section style={styles.ctaSection}>
        <EmailButton href={billingPortalUrl} variant="primary">
          Add Payment Method
        </EmailButton>
      </Section>

      <Text style={styles.note}>
        Already added payment details?{' '}
        <Link href={dashboardUrl} style={styles.link}>
          Head back to your dashboard
        </Link>
        . Have questions? Reply to this email.
      </Text>
    </BaseLayout>
  );
}

export function getTrialEndingReminderSubject(planName: string, daysRemaining: number): string {
  const dayLabel = daysRemaining === 1 ? 'tomorrow' : `in ${daysRemaining} days`;
  return `Your ${planName} trial ends ${dayLabel} — SheriaBot`;
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
  urgencyBanner: {
    border: '1px solid',
    borderRadius: '6px',
    padding: '14px 18px',
    margin: '0 0 20px',
  },
  urgencyText: {
    fontSize: '14px',
    fontWeight: '600',
    margin: '0',
    lineHeight: '1.4',
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
