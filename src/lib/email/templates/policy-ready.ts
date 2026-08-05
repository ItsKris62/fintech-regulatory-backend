import { emailConfig } from '@/config/email.config';
import { LOGO_URL, EMAIL_SIGNATURE_LOGO_URL } from '@/emails/theme';

/**
 * Policy ready email template parameters
 */
export interface PolicyReadyEmailParams {
  to?: string;
  email?: string;
  userId?: string;
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
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #1e293b;
      margin: 0;
      padding: 24px 0;
      background-color: #f8fafc;
    }
    .wrapper {
      max-width: 600px;
      margin: 0 auto;
      padding: 0 16px;
    }
    .header {
      background-color: #0f172a;
      border-top: 4px solid #15803d;
      border-radius: 12px 12px 0 0;
      padding: 24px 32px;
      text-align: center;
    }
    .logo-badge {
      background-color: #ffffff;
      border-radius: 8px;
      padding: 12px 24px;
      display: inline-block;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }
    .logo-img {
      max-width: 220px;
      width: 100%;
      height: auto;
      display: block;
      margin: 0 auto;
    }
    .card {
      background-color: #ffffff;
      padding: 36px 40px;
      border-left: 1px solid #e2e8f0;
      border-right: 1px solid #e2e8f0;
      border-bottom: 1px solid #e2e8f0;
      border-radius: 0 0 12px 12px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
    }
    .success-badge {
      display: inline-block;
      background-color: #f0fdf4;
      color: #166534;
      border: 1px solid #bbf7d0;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 16px;
    }
    h1 {
      color: #0f172a;
      font-size: 22px;
      font-weight: 700;
      margin-top: 0;
      margin-bottom: 10px;
    }
    .policy-title {
      font-size: 18px;
      color: #15803d;
      font-weight: 600;
      margin: 15px 0;
    }
    .content {
      color: #334155;
      font-size: 15px;
      line-height: 1.7;
    }
    .button {
      display: inline-block;
      padding: 14px 32px;
      background-color: #15803d;
      color: #ffffff !important;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 600;
      font-size: 15px;
      margin: 24px 0;
    }
    .stats-grid {
      display: table;
      width: 100%;
      margin: 20px 0;
    }
    .stat-card {
      display: table-cell;
      background-color: #f8fafc;
      border: 1px solid #e2e8f0;
      padding: 16px;
      border-radius: 6px;
      text-align: center;
      width: 50%;
    }
    .stat-value {
      font-size: 22px;
      font-weight: bold;
      color: #15803d;
    }
    .stat-label {
      font-size: 12px;
      color: #64748b;
      margin-top: 4px;
    }
    .summary-box {
      background-color: #f8fafc;
      border-left: 4px solid #15803d;
      padding: 16px;
      margin: 20px 0;
      border-radius: 6px;
      font-size: 14px;
    }
    .tag {
      display: inline-block;
      background-color: #f1f5f9;
      color: #334155;
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      margin: 4px 4px 4px 0;
    }
    .footer {
      padding: 24px 16px 0;
      text-align: center;
      color: #94a3b8;
      font-size: 12px;
    }
    .footer a {
      color: #15803d;
      text-decoration: none;
      font-weight: 500;
    }
    ul, ol {
      padding-left: 20px;
    }
    li {
      margin: 6px 0;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="logo-badge">
        <img src="${LOGO_URL}" alt="SheriaBot" class="logo-img" />
      </div>
    </div>

    <div class="card">
      <div class="success-badge">✓ Generation Complete</div>

      <h1>Your Policy Framework is Ready! 🎉</h1>

      <div class="content">
        <p>Hello ${params.name},</p>

        <p>Great news! Your AI-generated policy framework has been completed and is ready for review.</p>

        <div class="policy-title">${params.policyTitle}</div>

        ${params.executiveSummary ? `
          <div class="summary-box">
            <strong>Executive Summary:</strong><br>
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
        <div style="margin-bottom: 20px;">
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

        <p>Best regards,<br><strong>The SheriaBot Team</strong></p>
      </div>

      <div class="footer">
        <div style="margin-bottom: 16px; text-align: center;">
          <img src="${EMAIL_SIGNATURE_LOGO_URL}" alt="SheriaBot — Your Legal Tech Assistant" style="max-width: 100%; width: 440px; height: auto; border-radius: 8px;" />
        </div>
        <p>${emailConfig.content.footer}</p>
        <p>
          <a href="${emailConfig.content.privacyPolicyUrl}">Privacy Policy</a> &bull; 
          <a href="${emailConfig.content.termsUrl}">Terms of Service</a>
        </p>
      </div>
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
