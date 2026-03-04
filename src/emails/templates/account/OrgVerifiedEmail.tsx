import * as React from 'react';
import { Section, Text } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface OrgVerifiedEmailProps {
  userName: string;
  organizationName: string;
  dashboardUrl: string;
}

const UNLOCKED_FEATURES = [
  'AI-powered policy document generation',
  'Advanced gap analysis and compliance scoring',
  'Team member management and role assignment',
  'Regulatory document ingestion and search',
  'Priority support access',
];

export function OrgVerifiedEmail({
  userName,
  organizationName,
  dashboardUrl,
}: OrgVerifiedEmailProps) {
  return (
    <BaseLayout preheaderText={`${organizationName} is now verified — full access unlocked`}>
      <Text style={styles.greeting}>Hi {userName},</Text>

      <Section style={styles.successBanner}>
        <Text style={styles.successText}>
          &#10003; Your organization, <strong>{organizationName}</strong>, has been verified.
          You now have full access to all SheriaBot features.
        </Text>
      </Section>

      <Text style={styles.body}>Here is what has been unlocked for your organization:</Text>

      <Section style={styles.featuresSection}>
        {UNLOCKED_FEATURES.map((feature) => (
          <Text key={feature} style={styles.featureItem}>
            &#10004; {feature}
          </Text>
        ))}
      </Section>

      <Section style={styles.ctaSection}>
        <EmailButton href={dashboardUrl}>Explore Full Features</EmailButton>
      </Section>
    </BaseLayout>
  );
}

export const OrgVerifiedEmailSubject = 'Your Organization Has Been Verified on SheriaBot';

const styles: Record<string, React.CSSProperties> = {
  greeting: {
    color: EMAIL_THEME.colors.text,
    fontSize: '16px',
    fontWeight: '600',
    margin: '0 0 16px',
  },
  successBanner: {
    backgroundColor: EMAIL_THEME.colors.successBg,
    borderLeft: `4px solid ${EMAIL_THEME.colors.success}`,
    borderRadius: '4px',
    padding: '16px',
    margin: '0 0 20px',
  },
  successText: {
    color: EMAIL_THEME.colors.success,
    fontSize: '14px',
    fontWeight: '600',
    margin: '0',
  },
  body: {
    color: EMAIL_THEME.colors.text,
    fontSize: '15px',
    lineHeight: '1.6',
    margin: '0 0 16px',
  },
  featuresSection: {
    backgroundColor: EMAIL_THEME.colors.background,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius: '6px',
    padding: '16px 20px',
    margin: '0 0 24px',
  },
  featureItem: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    margin: '6px 0',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '24px 0',
  },
};
