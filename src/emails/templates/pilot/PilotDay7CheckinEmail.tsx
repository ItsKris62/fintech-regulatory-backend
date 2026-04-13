import * as React from 'react';
import { Section, Text } from '@react-email/components';
import { BaseLayout } from '../../components/BaseLayout';
import { EmailButton } from '../../components/EmailButton';
import { EMAIL_THEME } from '../../theme';

export interface PilotDay7CheckinEmailProps {
  userName:      string;
  daysRemaining: number;
  dashboardUrl:  string;
  surveyUrl?:    string;
}

export function PilotDay7CheckinEmail({
  userName,
  daysRemaining,
  dashboardUrl,
  surveyUrl,
}: PilotDay7CheckinEmailProps) {
  const suggestions: string[] = [
    'Run a Gap Analysis — upload a policy document to identify missing controls',
    'Try the AI Compliance Query — ask a specific regulatory question',
    'Export a checklist to PDF — share with your compliance team',
  ];

  return (
    <BaseLayout preheaderText={`Halfway through your pilot — ${daysRemaining} days left`}>
      <Text style={styles.greeting}>Hi {userName},</Text>

      <Text style={styles.body}>
        You're at the halfway point of your SheriaBot pilot — <strong>{daysRemaining} days remaining</strong>.
        We'd love to hear how it's going so far.
      </Text>

      {surveyUrl ? (
        <Section style={styles.surveyBox}>
          <Text style={styles.surveyTitle}>2-minute feedback survey</Text>
          <Text style={styles.surveyText}>
            Your input directly influences our roadmap. It takes about 2 minutes and makes a
            real difference to what we build next.
          </Text>
          <Section style={styles.ctaSection}>
            <EmailButton href={surveyUrl} variant="primary">
              Share Your Feedback
            </EmailButton>
          </Section>
        </Section>
      ) : null}

      <Text style={styles.sectionHeading}>If you haven't tried these yet:</Text>
      <Section style={styles.listBox}>
        {suggestions.map((s) => (
          <Text key={s} style={styles.listItem}>
            &bull;&nbsp; {s}
          </Text>
        ))}
      </Section>

      <Section style={styles.ctaSection}>
        <EmailButton href={dashboardUrl} variant={surveyUrl ? 'secondary' : 'primary'}>
          Go to Dashboard
        </EmailButton>
      </Section>

      <Text style={styles.note}>
        Questions or anything you'd like to discuss live? Reply to this email to arrange a call.
      </Text>
    </BaseLayout>
  );
}

export function getPilotDay7CheckinSubject(daysRemaining: number): string {
  return `Your SheriaBot pilot: halfway check-in (${daysRemaining} days left)`;
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
    margin: '0 0 16px',
  },
  surveyBox: {
    backgroundColor: EMAIL_THEME.colors.successBg,
    border: `1px solid ${EMAIL_THEME.colors.border}`,
    borderRadius: '6px',
    padding: '16px 18px',
    margin: '0 0 20px',
  },
  surveyTitle: {
    color: EMAIL_THEME.colors.text,
    fontSize: '13px',
    fontWeight: '600',
    margin: '0 0 6px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  surveyText: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '14px',
    lineHeight: '1.5',
    margin: '0',
  },
  sectionHeading: {
    color: EMAIL_THEME.colors.text,
    fontSize: '14px',
    fontWeight: '600',
    margin: '0 0 8px',
  },
  listBox: {
    margin: '0 0 20px',
  },
  listItem: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '14px',
    lineHeight: '1.6',
    margin: '0 0 6px',
  },
  ctaSection: {
    textAlign: 'center',
    margin: '20px 0',
  },
  note: {
    color: EMAIL_THEME.colors.textSecondary,
    fontSize: '13px',
    lineHeight: '1.5',
    textAlign: 'center',
    margin: '0',
  },
};
