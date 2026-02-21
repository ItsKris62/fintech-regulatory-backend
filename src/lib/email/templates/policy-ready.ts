import { emailConfig } from '@/config/email.config';

/**
 * Policy ready email template parameters
 */
export interface PolicyReadyEmailParams {
  name: string;
  policyTitle: string;
  policyId: string;
  policyUrl: string;
  executiveSummary?: string;
  regulatoryAreas: string[];
  generationTime: number; // milliseconds
  citationCount?: number;
}

/**
 * Format generation time
 */
function formatGenerationTime(ms: number): string {
  if (ms < 60000) {
    return `${Math.round(ms / 1000)} seconds`;
  }
  return `${Math.round(ms / 60000)} minutes`;
}

/**
 * Generate policy ready email HTML
 */
function generatePolicyReadyHTML(params: PolicyReadyEmailParams): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Policy is Ready</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background-color: #ffffff;
      border-radius: 8px;
      padding: 40px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .header {
      text-align: center;
      margin-bottom: 30px;
    }
    .logo {
      font-size: 32px;
      font-weight: bold;
      color: ${emailConfig.branding.primaryColor};
      margin-bottom: 10px;
    }
    .success-badge {
      display: inline-block;
      background-color: #d4edda;
      color: #155724;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 20px;
    }
    h1 {
      color: #1a1a1a;
      font-size: 24px;
      margin-bottom: 10px;
    }
    .policy-title {
      font-size: 20px;
      color: ${emailConfig.branding.primaryColor};
      font-weight: 600;
      margin: 15px 0;
    }
    .content {
      color: #4a4a4a;
      font-size: 16px;
      line-height: 1.8;
    }
    .button {
      display: inline-block;
      padding: 14px 30px;
      background-color: ${emailConfig.branding.primaryColor};
      color: #ffffff !important;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 600;
      margin: 25px 0;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 15px;
      margin: 25px 0;
    }
    .stat-card {
      background-color: #f8f9fa;
      padding: 15px;
      border-radius: 6px;
      text-align: center;
    }
    .stat-value {
      font-size: 24px;
      font-weight: bold;
      color: ${emailConfig.branding.primaryColor};
    }
    .stat-label {
      font-size: 13px;
      color: #666;
      margin-top: 5px;
    }
    .summary-box {
      background-color: #f8f9fa;
      border-left: 4px solid ${emailConfig.branding.primaryColor};
      padding: 20px;
      margin: 20px 0;
      border-radius: 4px;
    }
    .tag {
      display: inline-block;
      background-color: #e9ecef;
      color: #495057;
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 13px;
      margin: 4px;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e0e0e0;
      text-align: center;
      color: #888;
      font-size: 13px;
    }
    .footer a {
      color: ${emailConfig.branding.primaryColor};
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">SheriaBot</div>
      <div class="success-badge">✓ Generation Complete</div>
    </div>

    <h1>Your Policy Framework is Ready! 🎉</h1>

    <div class="content">
      <p>Hello ${params.name},</p>

      <p>Great news! Your AI-generated policy framework has been completed and is ready for review.</p>

      <div class="policy-title">${params.policyTitle}</div>

      ${params.executiveSummary ? `
        <div class="summary-box">
          <strong>Executive Summary</strong><br>
          ${params.executiveSummary}
        </div>
      ` : ''}

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">${formatGenerationTime(params.generationTime)}</div>
          <div class="stat-label">Generation Time</div>
        </div>
        ${params.citationCount ? `
          <div class="stat-card">
            <div class="stat-value">${params.citationCount}</div>
            <div class="stat-label">Legal Citations</div>
          </div>
        ` : ''}
      </div>

      <p><strong>Regulatory Areas Covered:</strong></p>
      <div>
        ${params.regulatoryAreas.map(area => `<span class="tag">${area}</span>`).join('')}
      </div>

      <div style="text-align: center;">
        <a href="${params.policyUrl}" class="button">
          View Policy Framework
        </a>
      </div>

      <p><strong>What's Included:</strong></p>
      <ul>
        <li>Comprehensive executive summary</li>
        <li>Regulatory analysis with legal citations</li>
        <li>Policy recommendations</li>
        <li>Compliance checklist</li>
        <li>Referenced Kenyan laws and regulations</li>
      </ul>

      <p><strong>Next Steps:</strong></p>
      <ol>
        <li>Review the generated policy framework</li>
        <li>Verify all citations against source documents</li>
        <li>Add comments or request refinements if needed</li>
        <li>Export to PDF or Word for distribution</li>
        <li>Share with stakeholders for feedback</li>
      </ol>

      <p>Need to make changes? You can refine this policy by providing additional instructions or context within the platform.</p>

      <p>Questions? Contact us at <a href="mailto:${emailConfig.branding.supportEmail}">${emailConfig.branding.supportEmail}</a>.</p>

      <p>Best regards,<br>The SheriaBot Team</p>
    </div>

    <div class="footer">
      <p>${emailConfig.content.footer}</p>
      <p>
        <a href="${emailConfig.content.privacyPolicyUrl}">Privacy Policy</a> | 
        <a href="${emailConfig.content.termsUrl}">Terms of Service</a>
      </p>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Generate policy ready email plain text version
 */
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