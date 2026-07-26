/**
 * KenyanComplianceBriefEmail
 *
 * "The Kenyan Compliance Brief" - the recurring multi-item regulatory digest.
 * Unlike ComplianceUpdateEmail (one regulator update per send), this template
 * renders a list of named item slots (title/summary/optional source link) so
 * a single weekly send can cover several regulatory items at once.
 *
 * Subject suggestion:
 *   "The Kenyan Compliance Brief - {editionLabel}"
 */

import * as React from 'react';
import { Text, Section, Hr, Link } from '@react-email/components';
import { MarketingBaseLayout } from './MarketingBaseLayout';
import { EMAIL_THEME } from '../../theme';

export interface ComplianceBriefItem {
  title: string;
  summary: string;
  sourceUrl?: string;
}

export interface KenyanComplianceBriefEmailProps {
  recipientFirstName?: string;
  editionLabel: string;
  intro?: string;
  items: ComplianceBriefItem[];
  unsubscribeUrl: string;
}

export default function KenyanComplianceBriefEmail({
  recipientFirstName,
  editionLabel,
  intro,
  items,
  unsubscribeUrl,
}: KenyanComplianceBriefEmailProps) {
  const greeting = recipientFirstName ? `Hi ${recipientFirstName},` : 'Hi there,';

  return (
    <MarketingBaseLayout
      preheaderText={`${items.length} regulatory update${items.length === 1 ? '' : 's'} this week - The Kenyan Compliance Brief.`}
      unsubscribeUrl={unsubscribeUrl}
      campaignName="The Kenyan Compliance Brief"
    >
      {/* Edition badge */}
      <Section style={styles.badgeSection}>
        <Text style={styles.badge}>THE KENYAN COMPLIANCE BRIEF</Text>
      </Section>

      <Text style={styles.editionLabel}>{editionLabel}</Text>

      {/* Greeting */}
      <Text style={styles.greeting}>{greeting}</Text>

      {/* Optional intro */}
      {intro && <Text style={styles.body}>{intro}</Text>}

      {/* Items */}
      {items.map((item, index) => (
        <React.Fragment key={`${item.title}-${index}`}>
          <Section style={styles.itemSection}>
            <Text style={styles.itemTitle}>{item.title}</Text>
            <Text style={styles.itemSummary}>{item.summary}</Text>
            {item.sourceUrl && (
              <Link href={item.sourceUrl} style={styles.itemLink}>
                Read the source &rarr;
              </Link>
            )}
          </Section>
          {index < items.length - 1 && <Hr style={styles.divider} />}
        </React.Fragment>
      ))}

      <Hr style={styles.divider} />

      <Text style={styles.footer}>
        SheriaBot monitors regulatory publications from CBK, ODPC, CMA, and CA
        so you don&apos;t have to check each regulator&apos;s site yourself.
      </Text>

      <Text style={styles.signoff}>
        - The SheriaBot Team
      </Text>
    </MarketingBaseLayout>
  );
}

const styles: Record<string, React.CSSProperties> = {
  badgeSection: {
    margin: '0 0 12px',
  },
  badge: {
    backgroundColor: EMAIL_THEME.colors.primary,
    color:           '#FFFFFF',
    fontSize:        '11px',
    fontWeight:      '700',
    letterSpacing:   '0.08em',
    padding:         '4px 10px',
    borderRadius:    '4px',
    display:         'inline-block',
    margin:          '0',
  },
  editionLabel: {
    color:      EMAIL_THEME.colors.textSecondary,
    fontSize:   '13px',
    fontWeight: '600',
    margin:     '0 0 16px',
  },
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
  itemSection: {
    backgroundColor: EMAIL_THEME.colors.successBg,
    borderLeft:      `4px solid ${EMAIL_THEME.colors.primary}`,
    borderRadius:    '4px',
    padding:         '16px 20px',
    margin:          '0 0 16px',
  },
  itemTitle: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '15px',
    fontWeight: '600',
    margin:     '0 0 6px',
  },
  itemSummary: {
    color:      EMAIL_THEME.colors.text,
    fontSize:   '14px',
    lineHeight: '1.6',
    margin:     '0 0 8px',
  },
  itemLink: {
    color:          EMAIL_THEME.colors.primary,
    fontSize:       '13px',
    fontWeight:     '600',
    textDecoration: 'none',
  },
  divider: {
    borderColor: EMAIL_THEME.colors.border,
    margin:      '16px 0',
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
