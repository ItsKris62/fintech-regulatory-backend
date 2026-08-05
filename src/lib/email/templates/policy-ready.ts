import { emailConfig } from '@/config/email.config';
import { LOGO_URL } from '@/emails/theme';

/**
 * Policy ready email template parameters
 */
export interface PolicyReadyEmailParams {
  to?: string;
  email?: string;
  userId?: string;
  name: string;
function generatePolicyReadyText(params: PolicyReadyEmailParams): string {
  return `
YOUR POLICY FRAMEWORK IS READY!

Hello ${params.name},

Great news! Your AI-generated policy framework has been completed and is ready for review.

POLICY TITLE
${params.policyTitle}

${params.executiveSummary ? `
EXECUTIVE SUMMARY
${params.executiveSummary}
` : ''}

STATISTICS
• Generation Time: ${formatGenerationTime(params.generationTime)}
${params.citationCount ? `• Legal Citations: ${params.citationCount}` : ''}

REGULATORY AREAS COVERED
${params.regulatoryAreas.map(area => `• ${area}`).join('\n')}

VIEW YOUR POLICY
${params.policyUrl}

WHAT'S INCLUDED
• Comprehensive executive summary
• Regulatory analysis with legal citations
• Policy recommendations
• Compliance checklist
• Referenced Kenyan laws and regulations

NEXT STEPS
1. Review the generated policy framework
2. Verify all citations against source documents
3. Add comments or request refinements if needed
4. Export to PDF or Word for distribution
5. Share with stakeholders for feedback

Need to make changes? You can refine this policy by providing additional instructions or context within the platform.

NEED HELP?
Contact us at ${emailConfig.branding.supportEmail}

Best regards,
The SheriaBot Team

---
${emailConfig.content.footer}

Privacy Policy: ${emailConfig.content.privacyPolicyUrl}
Terms of Service: ${emailConfig.content.termsUrl}
  `.trim();
}

/**
 * Generate complete policy ready email
 */
export function generatePolicyReadyEmail(params: PolicyReadyEmailParams): {
  html: string;
  text: string;
  subject: string;
} {
  return {
    html: generatePolicyReadyHTML(params),
    text: generatePolicyReadyText(params),
    subject: `✓ Your Policy Framework is Ready: ${params.policyTitle}`,
  };
}
