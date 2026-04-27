import * as React from 'react';
import { Section, Text, Hr, Link } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface RegulatoryAlertEmailProps {
  recipientName: string;
  alertTitle: string;
  alertSummary: string;
  alertBody: string;
  regulatoryBody: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  effectiveDate?: string;
  sourceUrl?: string;
  alertUrl: string;
  unsubscribeUrl: string;
}

const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: '#EF4444',
  HIGH: '#F97316',
  MEDIUM: '#EAB308',
  LOW: '#22C55E',
};

const SEVERITY_LABELS: Record<string, string> = {
  CRITICAL: 'Critical -- Immediate action required',
  HIGH: 'High priority regulatory update',
  MEDIUM: 'Regulatory update',
  LOW: 'Informational update',
};

export function RegulatoryAlertEmail({
  recipientName,
  alertTitle,
  alertSummary,
  alertBody,
  regulatoryBody,
  severity,
  effectiveDate,
  sourceUrl,
  alertUrl,
  unsubscribeUrl,
}: RegulatoryAlertEmailProps) {
  const severityColor = SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.MEDIUM;
  const severityLabel = SEVERITY_LABELS[severity] ?? 'Regulatory update';
  const bodyPreview = alertBody.length > 500
    ? alertBody.slice(0, 500) + '...'
    : alertBody;

  return (
    <BaseLayout
      preheaderText={`[${severity}] ${regulatoryBody}: ${alertTitle}`}
      showUnsubscribe={false}
    >
      {/* Greeting */}
      <Text style={styles.greeting}>Hello {recipientName},</Text>

      {/* Severity colour bar */}
      <Section style={{ ...styles.severityBar, backgroundColor: severityColor }} />

      {/* Severity + source label */}
      <Text style={styles.metaLine}>
        <span style={{ color: severityColor, fontWeight: '700' }}>{severity}</span>
        {'  *  '}
        <span style={styles.sourceTag}>{regulatoryBody}</span>
      </Text>

      {/* Alert label */}
      <Text style={styles.alertLabel}>REGULATORY ALERT</Text>

      {/* Title */}
      <Text style={styles.title}>{alertTitle}</Text>

      {/* Severity description */}
      <Text style={styles.severityDesc}>{severityLabel}</Text>

      {/* Effective date */}
      {effectiveDate && (
        <Text style={styles.effectiveDate}>Effective date: {effectiveDate}</Text>
      )}

      {/* Summary */}
      <Text style={styles.summary}>{alertSummary}</Text>

      <Hr style={styles.divider} />

      {/* Body preview */}
      <Text style={styles.body}>{bodyPreview}</Text>

      {/* CTA */}
      <Section style={styles.ctaSection}>
        <EmailButton href={alertUrl} variant="primary">View Full Alert</EmailButton>
      </Section>

      {/* Source link */}
      {sourceUrl && (
        <Text style={styles.sourceLink}>
          <Link href={sourceUrl} style={styles.link}>
            View original source &rarr;
          </Link>
        </Text>
      )}

      <Hr style={styles.divider} />

      {/* Footer note */}
      <Text style={styles.footerNote}>
        You received this because your organisation subscribed to {regulatoryBody} alerts on
        SheriaBot.{' '}
        <Link href={unsubscribeUrl} style={styles.link}>Manage notification preferences</Link>
      </Text>
    </BaseLayout>
  );
}

export function getRegulatoryAlertEmailSubject(
  severity: string,
  regulatoryBody: string,
  title: string
): string {
  return `[${severity}] ${regulatoryBody}: ${title}`;
}

const styles: Record<string, React.CSSProperties> = {
  greeting: {
    color: EMAIL_THEME.colors.text,
    fontSize: '15px',
    margin: '0 0 20px',
  },
  severityBar: {
    height: '4px',
    borderRadius: '2px 2px 0 0',
    margin: '-32px -40px 20px',
  },
  metaLine: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '12px',
    margin: '0 0 4px',
    letterSpacing: '0.02em',
  },
  sourceTag: {
    color: EMAIL_THEME.colors.textSecondary,
    fontWeight: '600',
  },
  alertLabel: {
    color: EMAIL_THEME.colors.textMuted,
    fontSize: '10px',
    fontWeight: '700',
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    margin: '0 0 12px',
  },
  title: {
    color: EMAIL_THEME.colors.text,
    fontSize: '20px',
    fontWeight: '700',
    lineHeight: '1.3',
    margin: '0 0 8px',
  },
  severityDesc: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    margin: '0 0 12px',
    fontStyle: 'italic',
  },
  effectiveDate: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    fontWeight: '600',
    margin: '0 0 16px',
  },
  summary: {
    color: EMAIL_THEME.colors.text,
    fontSize: '15px',
    lineHeight: '1.6',
    margin: '0 0 16px',
  },
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    margin: '16px 0',
  },
  body: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '14px',
    lineHeight: '1.65',
    margin: '0 0 24px',
    whiteSpace: 'pre-wrap',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '0 0 16px',
  },
  sourceLink: {
    textAlign: 'center',
    fontSize: '13px',
    margin: '0 0 16px',
  },
  link: {
    color: EMAIL_THEME.colors.primaryLight,
    textDecoration: 'none',
  },
  footerNote: {
    color: EMAIL_THEME.colors.textMuted,
    fontSize: '12px',
    lineHeight: '1.5',
    textAlign: 'center',
    margin: '0',
  },
};
