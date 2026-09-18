import * as React from 'react';
import { Section, Text, Hr, Link } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME, SHERIA_EMAIL_PALETTE, SEVERITY_MATRIX } from '../../theme';

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
  statutoryCitations?: string[];
}

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
  statutoryCitations,
}: RegulatoryAlertEmailProps) {
  const sevConfig = SEVERITY_MATRIX[severity] ?? SEVERITY_MATRIX.MEDIUM;
  const bodyPreview =
    alertBody.length > 500 ? alertBody.slice(0, 500) + '...' : alertBody;

  return (
    <BaseLayout
      preheaderText={`[${severity}] ${regulatoryBody}: ${alertTitle}`}
      showUnsubscribe={false}
      headerBadgeText={`${regulatoryBody} • DIRECTIVE`}
      unsubscribeUrl={unsubscribeUrl}
    >
      {/* Top Severity Alert Strip */}
      <table
        border={0}
        cellPadding={0}
        cellSpacing={0}
        width="100%"
        style={{
          backgroundColor: sevConfig.bg,
          borderLeft: `4px solid ${sevConfig.border}`,
          borderRadius: '4px',
          margin: '0 0 20px 0',
        }}
      >
        <tbody>
          <tr>
            <td style={{ padding: '12px 16px' }}>
              <table border={0} cellPadding={0} cellSpacing={0} width="100%">
                <tbody>
                  <tr>
                    <td align="left">
                      <span
                        style={{
                          fontFamily: EMAIL_THEME.fonts.sans,
                          fontSize: '11px',
                          fontWeight: '700',
                          color: sevConfig.text,
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                        }}
                      >
                        {sevConfig.icon} {sevConfig.label}
                      </span>
                    </td>
                    <td align="right">
                      <span
                        style={{
                          fontFamily: EMAIL_THEME.fonts.citation,
                          fontSize: '11px',
                          fontWeight: '600',
                          color: sevConfig.text,
                        }}
                      >
                        {regulatoryBody}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Greeting */}
      <Text style={styles.greeting}>Dear {recipientName},</Text>

      {/* Title */}
      <h1 style={styles.title}>{alertTitle}</h1>

      {/* Summary */}
      <Text style={styles.summary}>{alertSummary}</Text>

      {/* Structured Regulatory Metadata Card */}
      <table
        border={0}
        cellPadding={0}
        cellSpacing={0}
        width="100%"
        style={styles.metadataCard}
      >
        <tbody>
          <tr>
            <td style={{ padding: '16px 20px' }}>
              <table border={0} cellPadding={0} cellSpacing={0} width="100%">
                <tbody>
                  <tr>
                    <td width="50%" style={{ verticalAlign: 'top', paddingBottom: '12px' }}>
                      <span style={styles.metaLabel}>Regulatory Authority</span>
                      <span style={styles.metaValue}>{regulatoryBody}</span>
                    </td>
                    <td width="50%" style={{ verticalAlign: 'top', paddingBottom: '12px' }}>
                      <span style={styles.metaLabel}>Effective Date</span>
                      <span style={{ ...styles.metaValue, color: effectiveDate ? sevConfig.text : '#0A0A0A' }}>
                        {effectiveDate || 'Immediate on Gazettement'}
                      </span>
                    </td>
                  </tr>
                  {statutoryCitations && statutoryCitations.length > 0 && (
                    <tr>
                      <td colSpan={2} style={{ verticalAlign: 'top' }}>
                        <span style={styles.metaLabel}>Statutory Citations</span>
                        <div style={{ marginTop: '4px' }}>
                          {statutoryCitations.map((cit, idx) => (
                            <span key={idx} style={styles.citationChip}>
                              {cit}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Body preview */}
      <Text style={styles.body}>{bodyPreview}</Text>

      {/* Primary CTA */}
      <Section style={styles.ctaSection}>
        <EmailButton href={alertUrl} variant="primary">
          Review Full Directive &amp; Action Plan &rarr;
        </EmailButton>
      </Section>

      {/* Source link */}
      {sourceUrl && (
        <Text style={styles.sourceLink}>
          <Link href={sourceUrl} style={styles.link}>
            View original gazette / regulatory source &rarr;
          </Link>
        </Text>
      )}

      <Hr style={styles.divider} />

      {/* Footer note */}
      <Text style={styles.footerNote}>
        You received this statutory notification because your organization is subscribed to{' '}
        <strong>{regulatoryBody}</strong> compliance intelligence feeds on SheriaBot.{' '}
        <Link href={unsubscribeUrl} style={styles.link}>
          Manage notification preferences
        </Link>
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
    color: SHERIA_EMAIL_PALETTE.text.body,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '14px',
    fontWeight: '600',
    margin: '0 0 12px',
  },
  title: {
    color: SHERIA_EMAIL_PALETTE.text.primary,
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '20px',
    lineHeight: '26px',
    fontWeight: '700',
    letterSpacing: '-0.01em',
    margin: '0 0 14px',
  },
  summary: {
    color: SHERIA_EMAIL_PALETTE.text.body,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '14px',
    lineHeight: '22px',
    margin: '0 0 20px',
  },
  metadataCard: {
    backgroundColor: SHERIA_EMAIL_PALETTE.surfaces.cardSubtle,
    border: `1px solid ${SHERIA_EMAIL_PALETTE.surfaces.borderLight}`,
    borderRadius: '6px',
    margin: '0 0 20px 0',
  },
  metaLabel: {
    color: SHERIA_EMAIL_PALETTE.text.muted,
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '11px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    display: 'block',
    marginBottom: '3px',
  },
  metaValue: {
    color: SHERIA_EMAIL_PALETTE.text.primary,
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '13px',
    fontWeight: '700',
    display: 'block',
  },
  citationChip: {
    backgroundColor: '#FFFFFF',
    border: `1px solid ${SHERIA_EMAIL_PALETTE.surfaces.borderLight}`,
    borderRadius: '3px',
    padding: '2px 7px',
    fontFamily: EMAIL_THEME.fonts.citation,
    fontSize: '11px',
    fontWeight: '600',
    color: SHERIA_EMAIL_PALETTE.brand.navy,
    display: 'inline-block',
    marginRight: '6px',
    marginBottom: '4px',
  },
  divider: {
    borderColor: SHERIA_EMAIL_PALETTE.surfaces.borderLight,
    margin: '20px 0',
  },
  body: {
    color: SHERIA_EMAIL_PALETTE.text.body,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '13px',
    lineHeight: '20px',
    margin: '0 0 20px',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '10px 0 16px',
  },
  sourceLink: {
    textAlign: 'center',
    fontSize: '12px',
    margin: '0 0 16px',
  },
  link: {
    color: SHERIA_EMAIL_PALETTE.brand.primary,
    fontWeight: '600',
    textDecoration: 'none',
  },
  footerNote: {
    color: SHERIA_EMAIL_PALETTE.text.muted,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '11px',
    lineHeight: '16px',
    textAlign: 'center',
    margin: '0',
  },
};
