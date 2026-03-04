import * as React from 'react';
import { Section, Text } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface RoleChangeEmailProps {
  userName: string;
  oldRole: string;
  newRole: string;
  changedBy: string;
  dashboardUrl: string;
}

function getRoleDescription(role: string): string {
  const r = role.toUpperCase();
  if (r === 'REGULATOR') return 'policy generation, regulatory oversight, and compliance analysis tools';
  if (r === 'ENTERPRISE') return 'enterprise compliance tools, policy generation, and team management features';
  if (r === 'ADMIN') return 'full administrative control of the SheriaBot platform';
  return 'compliance queries, basic policy guidance, and regulatory information';
}

export function RoleChangeEmail({
  userName,
  oldRole,
  newRole,
  changedBy,
  dashboardUrl,
}: RoleChangeEmailProps) {
  return (
    <BaseLayout preheaderText={`Your SheriaBot role has been updated to ${newRole}`}>
      <Text style={styles.greeting}>Hi {userName},</Text>
      <Text style={styles.body}>
        Your account role has been changed from <strong>{oldRole}</strong> to{' '}
        <strong>{newRole}</strong> by {changedBy}.
      </Text>

      <Section style={styles.roleCard}>
        <Text style={styles.roleLabel}>New Role Access</Text>
        <Text style={styles.roleValue}>{newRole}</Text>
        <Text style={styles.roleDescription}>
          You now have access to {getRoleDescription(newRole)}.
        </Text>
      </Section>

      <Section style={styles.ctaSection}>
        <EmailButton href={dashboardUrl}>Go to Dashboard</EmailButton>
      </Section>

      <Text style={styles.note}>
        If you believe this change was made in error, please contact your administrator.
      </Text>
    </BaseLayout>
  );
}

export const RoleChangeEmailSubject = 'Your SheriaBot Role Has Been Updated';

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
    margin: '0 0 20px',
  },
  roleCard: {
    backgroundColor: EMAIL_THEME.colors.background,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderLeft: `4px solid ${EMAIL_THEME.colors.primary}`,
    borderRadius: '0 6px 6px 0',
    padding: '16px',
    margin: '0 0 24px',
  },
  roleLabel: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '11px',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    margin: '0 0 4px',
  },
  roleValue: {
    color: EMAIL_THEME.colors.primary,
    fontSize: '18px',
    fontWeight: '700',
    margin: '0 0 8px',
  },
  roleDescription: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    margin: '0',
    lineHeight: '1.5',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '24px 0',
  },
  note: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    textAlign: 'center',
    margin: '8px 0 0',
  },
};
