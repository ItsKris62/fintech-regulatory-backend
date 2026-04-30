/**
 * RegulatorAccessProgramEmail
 *
 * Sent to staff at regulatory bodies (CBK, ODPC, CMA, CA) offering
 * free institutional access. Tone is institutional, not commercial.
 *
 * Subject suggestion:
 *   "Complimentary SheriaBot access for {regulatorName}"
 */

import * as React from 'react';
import { Text, Section, Hr } from '@react-email/components';
import { MarketingBaseLayout } from './MarketingBaseLayout';
import { MarketingEmailButton } from '../../components/MarketingEmailButton';
import { EMAIL_THEME } from '../../theme';

export interface RegulatorAccessProgramEmailProps {
  recipientFirstName?: string;
  regulatorName: string;
  signupUrl: string;
  unsubscribeUrl: string;
}

export default function RegulatorAccessProgramEmail({
  recipientFirstName,
  regulatorName,
  signupUrl,
  unsubscribeUrl,
}: RegulatorAccessProgramEmailProps) {
  const greeting = recipientFirstName ? `Dear ${recipientFirstName},` : 'Dear colleague,';

  return (
    <MarketingBaseLayout
      preheaderText={`Complimentary SheriaBot access for ${regulatorName} — supporting your supervisory mandate.`}
      unsubscribeUrl={unsubscribeUrl}
      campaignName="Regulator Access Programme"
    >
      {/* Greeting */}
      <Text style={styles.greeting}>{greeting}</Text>

      {/* Opening — acknowledge the regulator's mandate */}
      <Text style={styles.body}>
        As {regulatorName}&apos;s mandate continues to expand, supervised entities require
        increasingly sophisticated tools to maintain compliance. SheriaBot was built to
        support both regulated entities and the regulators who supervise them.
      </Text>

      <Text style={styles.body}>
        We are offering {regulatorName} complimentary institutional access — at no cost,
        with no commercial strings attached.
      </Text>

      <Hr style={styles.divider} />

      {/* Benefits framed for a regulator's perspective */}
      <Section style={styles.benefitsSection}>
        <Text style={styles.benefitsHeading}>What institutional access includes:</Text>
        <Text style={styles.bulletItem}>
          ✓ Oversight visibility into how supervised entities use the platform for compliance
        </Text>
        <Text style={styles.bulletItem}>
          ✓ Policy testing sandbox — review how your published guidelines are interpreted
          by AI-assisted compliance tools
        </Text>
        <Text style={styles.bulletItem}>
          ✓ Direct access to the same regulatory corpus your supervised entities query,
          including CBK, ODPC, CMA, and CA frameworks
        </Text>
      </Section>

      <Hr style={styles.divider} />

      {/* Confidentiality assurance */}
      <Section style={styles.confidentialitySection}>
        <Text style={styles.confidentialityText}>
          <strong>Confidentiality:</strong> Your usage data is kept entirely separate from
          supervised entities&apos; data. We do not share regulator queries with anyone —
          not with supervised entities, not with third parties.
        </Text>
      </Section>

      {/* CTA */}
      <Text style={styles.body}>
        To activate institutional access for {regulatorName}, please use the link below.
        No payment information is required.
      </Text>

      <MarketingEmailButton href={signupUrl} variant="primary">
        Activate Regulator Access
      </MarketingEmailButton>

      <Text style={styles.footer}>
        If you have questions about the programme or would prefer a briefing call,
        please reply to this email directly.
      </Text>

      <Text style={styles.signoff}>
        — The SheriaBot Team
      </Text>
    </MarketingBaseLayout>
  );
}

const styles: Record<string, React.CSSProperties> = {
  greeting: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '16px',
    lineHeight: '1.5',
    margin:     '0 0 16px',
  },
  body: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '15px',
    lineHeight: '1.6',
    margin:     '0 0 16px',
  },
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    margin:      '20px 0',
  },
  benefitsSection: {
    backgroundColor: EMAIL_THEME.colors.successBg,
    borderLeft:      `4px solid ${EMAIL_THEME.colors.primary}`,
    borderRadius:    '4px',
    padding:         '16px 20px',
    margin:          '0 0 16px',
  },
  benefitsHeading: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '14px',
    fontWeight: '600',
    margin:     '0 0 8px',
  },
  bulletItem: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '14px',
    lineHeight: '1.6',
    margin:     '0 0 6px',
  },
  confidentialitySection: {
    backgroundColor: '#F0F9FF',
    borderLeft:      '4px solid #0284C7',
    borderRadius:    '4px',
    padding:         '14px 18px',
    margin:          '0 0 16px',
  },
  confidentialityText: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '13px',
    lineHeight: '1.6',
    margin:     '0',
  },
  footer: {
    color:      EMAIL_THEME.colors.textSecondary,
    fontSize:   '13px',
    lineHeight: '1.5',
    margin:     '0 0 16px',
  },
  signoff: {
    color:      EMAIL_THEME.colors.textSecondary,
    fontSize:   '14px',
    lineHeight: '1.5',
    margin:     '16px 0 0',
  },
};
