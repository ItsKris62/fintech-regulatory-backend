import * as React from 'react';
import { Section, Text } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface AccountApprovedEmailProps {
  userName: string;
  role: string;
  dashboardUrl: string;
}

function getRoleAccess(role: string): string {
  const r = role.toUpperCase();
  if (r === 'REGULATOR') {
    return 'You can now access policy generation tools, regulatory oversight dashboards, and the full compliance analysis suite.';
  }
  if (r === 'ENTERPRISE') {
    return 'You can now access comprehensive compliance tools, policy generation, and enterprise reporting features.';
  }
  return 'You can now access all SheriaBot features, including compliance queries, policy generation, and regulatory guidance.';
}

export function AccountApprovedEmail({
  userName,
  role,
  dashboardUrl,
}: AccountApprovedEmailProps) {
  return (
    <BaseLayout preheaderText="Your SheriaBot account has been approved and is ready to use">
      <Text style={styles.greeting}>Hi {userName},</Text>

      <Section style={styles.successBanner}>
        <Text style={styles.successText}>
          &#10003; Great news! Your <strong>{role}</strong> account has been reviewed and approved.
        </Text>
      </Section>

      <Text style={styles.body}>{getRoleAccess(role)}</Text>

      <Section style={styles.ctaSection}>
        <EmailButton href={dashboardUrl}>Access Dashboard</EmailButton>
      </Section>
    </BaseLayout>
  );
}

export const AccountApprovedEmailSubject = 'Your SheriaBot Account Has Been Approved';

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
    margin: '0 0 24px',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '24px 0',
  },
};
