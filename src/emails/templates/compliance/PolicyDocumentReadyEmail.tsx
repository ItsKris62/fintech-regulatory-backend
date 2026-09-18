import * as React from 'react';
import { Section, Text } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME, SHERIA_EMAIL_PALETTE } from '../../theme';

export interface PolicyDocumentReadyEmailProps {
  userName: string;
  documentTitle: string;
  documentType: string;
  documentUrl: string;
  generatedAt: string;
  complianceScore?: number;
  criticalGapCount?: number;
  advisoryFlagCount?: number;
  compliantCount?: number;
  frameworks?: string[];
}

export function PolicyDocumentReadyEmail({
  userName,
  documentTitle,
  documentType,
  documentUrl,
  generatedAt,
  complianceScore,
  criticalGapCount,
  advisoryFlagCount,
  compliantCount,
  frameworks,
}: PolicyDocumentReadyEmailProps) {
  const hasScore = typeof complianceScore === 'number';
  const scoreColor =
    (complianceScore ?? 0) >= 80
      ? SHERIA_EMAIL_PALETTE.brand.primary
      : (complianceScore ?? 0) >= 60
      ? SHERIA_EMAIL_PALETTE.brand.gold
      : '#DC2626';

  const scoreLabel =
    (complianceScore ?? 0) >= 80
      ? 'COMPLIANT / LOW RISK'
      : (complianceScore ?? 0) >= 60
      ? 'REMEDIATION RECOMMENDED'
      : 'CRITICAL GAPS DETECTED';

  return (
    <BaseLayout
      preheaderText={`Your ${documentType} is ready for review on SheriaBot`}
      showUnsubscribe={true}
      headerBadgeText="AUDIT COMPLETE"
    >
      <Text style={styles.greeting}>Hello {userName},</Text>
      <h1 style={styles.title}>
        Policy Audit &amp; Document Generation Complete
      </h1>
      <Text style={styles.body}>
        Your <strong>{documentType}</strong> (<em>{documentTitle}</em>) has been generated and bench-checked against Kenya statutory frameworks.
      </Text>

      {/* Structured Document Card */}
      <table
        border={0}
        cellPadding={0}
        cellSpacing={0}
        width="100%"
        style={styles.documentCard}
      >
        <tbody>
          <tr>
            <td style={{ padding: '16px 20px' }}>
              <span style={styles.documentLabel}>Generated Policy Artifact</span>
              <span style={styles.documentTitle}>{documentTitle}</span>
              <span style={styles.documentMeta}>
                {documentType} &bull; Generated on {generatedAt}
              </span>

              {frameworks && frameworks.length > 0 && (
                <div style={{ marginTop: '10px' }}>
                  <span style={styles.metaLabel}>Benchmarked Frameworks:</span>
                  <div style={{ marginTop: '4px' }}>
                    {frameworks.map((fw, i) => (
                      <span key={i} style={styles.frameworkChip}>
                        {fw}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      {/* Compliance Scorecard Gauge Summary (If Score is Available) */}
      {hasScore && (
        <table
          border={0}
          cellPadding={0}
          cellSpacing={0}
          width="100%"
          style={styles.scorecardTable}
        >
          <tbody>
            <tr>
              <td style={{ padding: '20px' }}>
                <table border={0} cellPadding={0} cellSpacing={0} width="100%">
                  <tbody>
                    <tr>
                      <td
                        width="35%"
                        align="center"
                        style={{
                          borderRight: `1px solid ${SHERIA_EMAIL_PALETTE.surfaces.borderLight}`,
                          paddingRight: '16px',
                        }}
                      >
                        <span style={styles.scoreLabelHeader}>Compliance Score</span>
                        <div style={{ ...styles.scoreValue, color: scoreColor }}>
                          {complianceScore}
                          <span style={styles.percentSymbol}>%</span>
                        </div>
                        <span
                          style={{
                            backgroundColor: (complianceScore ?? 0) >= 80 ? '#E8F5EE' : '#FDF8EC',
                            border: `1px solid ${scoreColor}`,
                            color: scoreColor,
                            fontSize: '10px',
                            fontWeight: '700',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            display: 'inline-block',
                          }}
                        >
                          {scoreLabel}
                        </span>
                      </td>
                      <td width="65%" style={{ paddingLeft: '20px' }}>
                        {typeof criticalGapCount === 'number' && (
                          <div style={styles.metricRow}>
                            Critical Findings:{' '}
                            <span style={{ color: '#DC2626', fontWeight: '700' }}>
                              {criticalGapCount} {criticalGapCount === 1 ? 'Gap' : 'Gaps'}
                            </span>
                          </div>
                        )}
                        {typeof advisoryFlagCount === 'number' && (
                          <div style={styles.metricRow}>
                            Advisory Flags:{' '}
                            <span style={{ color: SHERIA_EMAIL_PALETTE.brand.gold, fontWeight: '700' }}>
                              {advisoryFlagCount} Items
                            </span>
                          </div>
                        )}
                        {typeof compliantCount === 'number' && (
                          <div style={styles.metricRow}>
                            Compliant Provisions:{' '}
                            <span style={{ color: SHERIA_EMAIL_PALETTE.brand.primary, fontWeight: '700' }}>
                              {compliantCount} Verified
                            </span>
                          </div>
                        )}

                        {/* Nested Outlook-Safe Progress Bar */}
                        <table
                          border={0}
                          cellPadding={0}
                          cellSpacing={0}
                          width="100%"
                          style={{
                            backgroundColor: '#E4E4E7',
                            borderRadius: '4px',
                            overflow: 'hidden',
                            marginTop: '8px',
                          }}
                        >
                          <tbody>
                            <tr>
                              <td
                                width={`${Math.min(100, Math.max(0, complianceScore ?? 0))}%`}
                                style={{
                                  backgroundColor: scoreColor,
                                  height: '6px',
                                  lineHeight: '6px',
                                  fontSize: '1px',
                                }}
                              >
                                &nbsp;
                              </td>
                              <td
                                width={`${100 - Math.min(100, Math.max(0, complianceScore ?? 0))}%`}
                                style={{
                                  backgroundColor: '#E4E4E7',
                                  height: '6px',
                                  lineHeight: '6px',
                                  fontSize: '1px',
                                }}
                              >
                                &nbsp;
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      )}

      {/* CTA */}
      <Section style={styles.ctaSection}>
        <EmailButton href={documentUrl} variant="primary">
          View Interactive Document &amp; Export &rarr;
        </EmailButton>
      </Section>

      {/* Institutional Legal Disclaimer Box */}
      <table
        border={0}
        cellPadding={0}
        cellSpacing={0}
        width="100%"
        style={styles.disclaimerBox}
      >
        <tbody>
          <tr>
            <td style={{ padding: '12px 16px' }}>
              <Text style={styles.disclaimerText}>
                <strong>Compliance Officer Note:</strong> AI-generated regulatory policy artifacts should be reviewed by qualified legal or risk professionals prior to official board adoption.
              </Text>
            </td>
          </tr>
        </tbody>
      </table>
    </BaseLayout>
  );
}

export const PolicyDocumentReadyEmailSubject = 'Your Policy Document Has Been Generated';

const styles: Record<string, React.CSSProperties> = {
  greeting: {
    color: SHERIA_EMAIL_PALETTE.text.body,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '14px',
    fontWeight: '600',
    margin: '0 0 10px',
  },
  title: {
    color: SHERIA_EMAIL_PALETTE.text.primary,
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '18px',
    lineHeight: '24px',
    fontWeight: '700',
    margin: '0 0 12px',
  },
  body: {
    color: SHERIA_EMAIL_PALETTE.text.body,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '14px',
    lineHeight: '22px',
    margin: '0 0 20px',
  },
  documentCard: {
    backgroundColor: SHERIA_EMAIL_PALETTE.surfaces.cardSubtle,
    border: `1px solid ${SHERIA_EMAIL_PALETTE.surfaces.borderLight}`,
    borderLeft: `4px solid ${SHERIA_EMAIL_PALETTE.brand.primary}`,
    borderRadius: '0 6px 6px 0',
    margin: '0 0 20px',
  },
  documentLabel: {
    color: SHERIA_EMAIL_PALETTE.text.muted,
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '11px',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    display: 'block',
    marginBottom: '4px',
  },
  documentTitle: {
    color: SHERIA_EMAIL_PALETTE.text.primary,
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '15px',
    fontWeight: '700',
    display: 'block',
    marginBottom: '4px',
  },
  documentMeta: {
    color: SHERIA_EMAIL_PALETTE.text.muted,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '12px',
    display: 'block',
  },
  metaLabel: {
    color: SHERIA_EMAIL_PALETTE.text.muted,
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '11px',
    fontWeight: '600',
    display: 'block',
  },
  frameworkChip: {
    backgroundColor: '#FFFFFF',
    border: `1px solid ${SHERIA_EMAIL_PALETTE.surfaces.borderLight}`,
    borderRadius: '3px',
    padding: '2px 6px',
    fontFamily: EMAIL_THEME.fonts.citation,
    fontSize: '11px',
    fontWeight: '600',
    color: SHERIA_EMAIL_PALETTE.brand.navy,
    display: 'inline-block',
    marginRight: '6px',
    marginTop: '2px',
  },
  scorecardTable: {
    backgroundColor: SHERIA_EMAIL_PALETTE.surfaces.cardSubtle,
    border: `1px solid ${SHERIA_EMAIL_PALETTE.surfaces.borderLight}`,
    borderRadius: '6px',
    margin: '0 0 20px',
  },
  scoreLabelHeader: {
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '11px',
    fontWeight: '700',
    color: SHERIA_EMAIL_PALETTE.text.muted,
    textTransform: 'uppercase',
    display: 'block',
  },
  scoreValue: {
    fontFamily: EMAIL_THEME.fonts.sans,
    fontSize: '32px',
    fontWeight: '800',
    lineHeight: '38px',
    margin: '4px 0',
  },
  percentSymbol: {
    fontSize: '18px',
    fontWeight: '600',
    color: SHERIA_EMAIL_PALETTE.text.muted,
  },
  metricRow: {
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '12px',
    fontWeight: '600',
    color: SHERIA_EMAIL_PALETTE.text.body,
    marginBottom: '4px',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '20px 0',
  },
  disclaimerBox: {
    backgroundColor: SHERIA_EMAIL_PALETTE.surfaces.cardSubtle,
    border: `1px solid ${SHERIA_EMAIL_PALETTE.surfaces.borderLight}`,
    borderRadius: '4px',
    margin: '16px 0 0',
  },
  disclaimerText: {
    color: SHERIA_EMAIL_PALETTE.text.muted,
    fontFamily: EMAIL_THEME.fonts.body,
    fontSize: '11px',
    lineHeight: '16px',
    margin: 0,
  },
};
