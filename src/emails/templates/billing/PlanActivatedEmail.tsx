import * as React from 'react';
import { Section, Text, Link, Hr, Row, Column } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface PlanActivatedEmailProps {
  userName: string;
  orgName: string;
  planName: string;          // e.g. "Startup" | "Business"
  trialEndsAt?: string;      // ISO date string — set when starting a trial
  billingPortalUrl: string;
  dashboardUrl: string;
  features: string[];        // Key features unlocked by this plan
}

export function PlanActivatedEmail({
  userName,
  orgName,
  planName,
  trialEndsAt,
  billingPortalUrl,
  dashboardUrl,
  features,
}: PlanActivatedEmailProps) {
  const isTrial = Boolean(trialEndsAt);
  const trialDate = trialEndsAt
    ? new Date(trialEndsAt).toLocaleDateString('en-KE', {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : null;

  return (
    <BaseLayout preheaderText={`${orgName} is now on the ${planName} plan — let's get started`}>
      <Text style={styles.greeting}>Hi {userName},</Text>

      <Text style={styles.body}>
        {isTrial
          ? `Your 14-day free trial of the SheriaBot ${planName} plan has started. No charge will be made until ${trialDate}.`
          : `Your organization ${orgName} is now on the SheriaBot ${planName} plan. Welcome aboard!`}
      </Text>

      {/* Plan badge */}
      <Section style={styles.planBadge}>
        <Text style={styles.planBadgeText}>{planName} Plan — Active</Text>
      </Section>

      {/* Features unlocked */}
      <Section style={styles.featuresCard}>
        <Text style={styles.featuresHeading}>What's included</Text>
        <Hr style={styles.divider} />
        {features.map((feature, i) => (
          <Row key={i} style={styles.featureRow}>
            <Column style={styles.featureCheck}>✓</Column>
            <Column style={styles.featureText}>{feature}</Column>
          </Row>
        ))}
      </Section>

      {isTrial && (
        <Section style={styles.trialNotice}>
          <Text style={styles.trialNoticeText}>
            Your free trial ends on <strong>{trialDate}</strong>. You can cancel anytime before
            then from your billing settings — no questions asked.
          </Text>
        </Section>
      )}

      <Section style={styles.ctaSection}>
        <EmailButton href={dashboardUrl} variant="primary">
          Go to Dashboard
        </EmailButton>
      </Section>

      <Text style={styles.note}>
        Manage your subscription anytime in{' '}
        <Link href={billingPortalUrl} style={styles.link}>
          Billing Settings
        </Link>
        . Questions? Reply to this email — we&apos;re here to help.
      </Text>
    </BaseLayout>
  );
}

export function getPlanActivatedSubject(planName: string, isTrial: boolean): string {
  return isTrial
    ? `Your ${planName} trial has started — SheriaBot`
    : `Welcome to the ${planName} plan — SheriaBot`;
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
    margin: '0 0 24px',
  },
  planBadge: {
    backgroundColor: EMAIL_THEME.colors.primary,
    borderRadius: '6px',
    padding: '14px 20px',
    textAlign: 'center',
    margin: '0 0 20px',
  },
  planBadgeText: {
    color: '#FFFFFF',
    fontSize: '17px',
    fontWeight: '700',
    margin: '0',
    letterSpacing: '0.3px',
  },
  featuresCard: {
    backgroundColor: EMAIL_THEME.colors.successBg,
    border: `1px solid ${EMAIL_THEME.colors.success}30`,
    borderRadius: '6px',
    padding: '20px',
    margin: '0 0 20px',
  },
  featuresHeading: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    fontWeight: '700',
    margin: '0 0 8px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    margin: '8px 0 12px',
  },
  featureRow: {
    marginBottom: '6px',
  },
  featureCheck: {
    color: EMAIL_THEME.colors.success,
    fontSize: '14px',
    fontWeight: '700',
    width: '20px',
    verticalAlign: 'top',
  },
  featureText: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    lineHeight: '1.5',
  },
  trialNotice: {
    backgroundColor: EMAIL_THEME.colors.warningBg,
    border: `1px solid ${EMAIL_THEME.colors.warning}40`,
    borderRadius: '6px',
    padding: '14px 18px',
    margin: '0 0 20px',
  },
  trialNoticeText: {
    color: EMAIL_THEME.colors.text,
    fontSize: '13px',
    lineHeight: '1.5',
    margin: '0',
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
