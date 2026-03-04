import * as React from 'react';
import { Section, Text } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME, APP_NAME } from '../../theme';

export interface InvitationEmailProps {
  inviterName: string;
  organizationName?: string;
  role: string;
  inviteUrl: string;
  expiresInDays: number;
}

export function InvitationEmail({
  inviterName,
  organizationName,
  role,
  inviteUrl,
  expiresInDays,
}: InvitationEmailProps) {
  return (
    <BaseLayout preheaderText={`${inviterName} invited you to join SheriaBot`}>
      <Text style={styles.heading}>
        You have been invited to join {APP_NAME}!
      </Text>
      <Text style={styles.body}>
        <strong>{inviterName}</strong> has invited you to join {APP_NAME}
        {organizationName ? ` as part of ${organizationName}` : ''}.
      </Text>

      <Text style={styles.body}>
        {APP_NAME} is an AI-powered regulatory compliance platform for Kenya's fintech sector.
        It helps organizations navigate complex regulations, generate compliance documents, and
        stay ahead of regulatory changes.
      </Text>

      <Section style={styles.roleCard}>
        <Text style={styles.roleLabel}>Your Assigned Role</Text>
        <Text style={styles.roleValue}>{role}</Text>
      </Section>

      <Section style={styles.ctaSection}>
        <EmailButton href={inviteUrl}>Accept Invitation</EmailButton>
      </Section>

      <Text style={styles.expiry}>
        This invitation expires in{' '}
        <strong>{expiresInDays} day{expiresInDays !== 1 ? 's' : ''}</strong>.
      </Text>
    </BaseLayout>
  );
}

export const InvitationEmailSubject = "You've been invited to join SheriaBot";

const styles: Record<string, React.CSSProperties> = {
  heading: {
    color: EMAIL_THEME.colors.primary,
    fontSize: '20px',
    fontWeight: '700',
    margin: '0 0 16px',
  },
  body: {
    color: EMAIL_THEME.colors.text,
    fontSize: '15px',
    lineHeight: '1.6',
    margin: '0 0 16px',
  },
  roleCard: {
    backgroundColor: EMAIL_THEME.colors.background,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderLeft: `4px solid ${EMAIL_THEME.colors.accent}`,
    borderRadius: '0 6px 6px 0',
    padding: '12px 16px',
    margin: '8px 0 24px',
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
    fontSize: '16px',
    fontWeight: '600',
    margin: '0',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '24px 0',
  },
  expiry: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    textAlign: 'center',
    margin: '8px 0 0',
  },
};
