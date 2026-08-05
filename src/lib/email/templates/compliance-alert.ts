import { emailConfig } from '@/config/email.config';
import { LOGO_URL } from '@/emails/theme';

/**
 * Compliance alert email template parameters
 */
export interface ComplianceAlertEmailParams {
  to?: string;
  email?: string;
  userId?: string;
  name: string;
function generateComplianceAlertText(params: ComplianceAlertEmailParams): string {
  return `
⚠️ COMPLIANCE ALERT

${params.severity} Priority: ${getAlertTypeLabel(params.alertType)}

Hello ${params.name},

We're notifying you about an important compliance matter that requires your attention.

ALERT
${params.alertTitle}

DESCRIPTION
${params.description}

${params.deadline ? `
⏰ ACTION DEADLINE
${params.deadline}
` : ''}

AFFECTED REGULATORY AREAS
${params.affectedAreas.map(area => `• ${area}`).join('\n')}

ACTION REQUIRED
${params.actionRequired}

${params.recommendations && params.recommendations.length > 0 ? `
OUR RECOMMENDATIONS
${params.recommendations.map((rec, i) => `${i + 1}. ${rec}`).join('\n')}
` : ''}

${params.resourceUrl ? `
VIEW FULL DETAILS
${params.resourceUrl}
` : ''}

NEXT STEPS
1. Review the compliance alert details carefully
2. Assess the impact on your organization
3. Take necessary action before the deadline
4. Update your compliance documentation
5. Consult with legal counsel if needed

NEED HELP?
Our compliance team can assist you with:
• Detailed regulatory analysis
• Compliance gap assessment
• Action plan development
• Policy framework updates

Contact us at ${emailConfig.branding.supportEmail} for assistance.

Best regards,
The SheriaBot Compliance Team

---
${emailConfig.content.footer}

Privacy Policy: ${emailConfig.content.privacyPolicyUrl}
Terms of Service: ${emailConfig.content.termsUrl}
  `.trim();
}

/**
 * Generate complete compliance alert email
 */
export function generateComplianceAlertEmail(params: ComplianceAlertEmailParams): {
  html: string;
  text: string;
  subject: string;
} {
  const severityPrefix = params.severity === 'CRITICAL' ? '🚨 URGENT: ' : 
                         params.severity === 'HIGH' ? '⚠️ Important: ' : '';

  return {
    html: generateComplianceAlertHTML(params),
    text: generateComplianceAlertText(params),
    subject: `${severityPrefix}Compliance Alert: ${params.alertTitle}`,
  };
}
