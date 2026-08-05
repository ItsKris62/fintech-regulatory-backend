import { emailConfig } from '@/config/email.config';
import { LOGO_URL, EMAIL_SIGNATURE_LOGO_URL } from '@/emails/theme';

/**
 * Compliance alert email template parameters
 */
export interface ComplianceAlertEmailParams {
  to?: string;
  email?: string;
  userId?: string;
  name: string;
  alertTitle: string;
  alertType: 'NEW_REGULATION' | 'REGULATION_CHANGE' | 'DEADLINE' | 'VIOLATION_RISK';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  affectedAreas: string[];
  actionRequired: string;
  deadline?: string;
  resourceUrl?: string;
  recommendations?: string[];
}

/**
 * Get severity color
 */
function getSeverityColor(severity: string): string {
  const colors = {
    LOW: '#15803d',
    MEDIUM: '#d97706',
    HIGH: '#ea580c',
    CRITICAL: '#dc2626',
  };
  return colors[severity as keyof typeof colors] || '#64748b';
}

/**
 * Get alert type label
 */
function getAlertTypeLabel(type: string): string {
  const labels = {
    NEW_REGULATION: 'New Regulation',
    REGULATION_CHANGE: 'Regulation Change',
    DEADLINE: 'Compliance Deadline',
    VIOLATION_RISK: 'Violation Risk',
  };
  return labels[type as keyof typeof labels] || type;
}

/**
 * Generate compliance alert email HTML
 */
function generateComplianceAlertHTML(params: ComplianceAlertEmailParams): string {
  const severityColor = getSeverityColor(params.severity);

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Compliance Alert</title>
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
    .alert-badge {
      display: inline-block;
      background-color: ${severityColor};
      color: #ffffff;
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
    .alert-title {
      font-size: 18px;
      color: ${severityColor};
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
      background-color: ${severityColor};
      color: #ffffff !important;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 600;
      font-size: 15px;
      margin: 24px 0;
    }
    .alert-box {
      background-color: #fffbe3;
      border-left: 4px solid ${severityColor};
      padding: 16px;
      margin: 20px 0;
      border-radius: 6px;
      font-size: 14px;
    }
    .info-box {
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
    .deadline-box {
      background-color: #fef2f2;
      border: 2px solid #dc2626;
      padding: 16px;
      margin: 20px 0;
      border-radius: 6px;
      text-align: center;
    }
    .deadline-date {
      font-size: 22px;
      font-weight: bold;
      color: #dc2626;
      margin: 8px 0 0;
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
      <div class="alert-badge">
        ${params.severity} Priority: ${getAlertTypeLabel(params.alertType)}
      </div>

      <h1>⚠️ Compliance Alert</h1>

      <div class="content">
        <p>Hello ${params.name},</p>

        <p>We're notifying you about an important compliance matter that requires your attention.</p>

        <div class="alert-title">${params.alertTitle}</div>

        <div class="alert-box">
          <strong>Description:</strong><br>
          ${params.description}
        </div>

        ${params.deadline ? `
          <div class="deadline-box">
            <div><strong>⏰ ACTION DEADLINE</strong></div>
            <div class="deadline-date">${params.deadline}</div>
          </div>
        ` : ''}

        <div class="info-box">
          <strong>Affected Regulatory Areas:</strong><br>
          <div style="margin-top: 8px;">
            ${params.affectedAreas.map(area => `<span class="tag">${area}</span>`).join('')}
          </div>
        </div>

        <p><strong>Action Required:</strong></p>
        <p>${params.actionRequired}</p>

        ${params.recommendations && params.recommendations.length > 0 ? `
          <p><strong>Our Recommendations:</strong></p>
          <ul>
            ${params.recommendations.map(rec => `<li>${rec}</li>`).join('')}
          </ul>
        ` : ''}

        ${params.resourceUrl ? `
          <div style="text-align: center;">
            <a href="${params.resourceUrl}" class="button">
              View Full Details
            </a>
          </div>
        ` : ''}

        <p><strong>Next Steps:</strong></p>
        <ol>
          <li>Review the compliance alert details carefully</li>
          <li>Assess the impact on your organization</li>
          <li>Take necessary action before the deadline</li>
          <li>Update your compliance documentation</li>
          <li>Consult with legal counsel if needed</li>
        </ol>

        <p>Contact us at <a href="mailto:${emailConfig.branding.supportEmail}">${emailConfig.branding.supportEmail}</a> for assistance.</p>

        <p>Best regards,<br><strong>The SheriaBot Compliance Team</strong></p>
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
 * Generate compliance alert email plain text version
 */
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
