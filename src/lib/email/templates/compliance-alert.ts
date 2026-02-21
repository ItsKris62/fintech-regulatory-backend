import { emailConfig } from '@/config/email.config';

/**
 * Compliance alert email template parameters
 */
export interface ComplianceAlertEmailParams {
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
    LOW: '#28a745',
    MEDIUM: '#ffc107',
    HIGH: '#fd7e14',
    CRITICAL: '#dc3545',
  };
  return colors[severity as keyof typeof colors] || '#6c757d';
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
    .alert-badge {
      display: inline-block;
      background-color: ${severityColor};
      color: #ffffff;
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
    .alert-title {
      font-size: 20px;
      color: ${severityColor};
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
      background-color: ${severityColor};
      color: #ffffff !important;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 600;
      margin: 25px 0;
    }
    .alert-box {
      background-color: #fff3cd;
      border-left: 4px solid ${severityColor};
      padding: 20px;
      margin: 20px 0;
      border-radius: 4px;
    }
    .info-box {
      background-color: #f8f9fa;
      border-left: 4px solid ${emailConfig.branding.primaryColor};
      padding: 15px;
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
    .deadline-box {
      background-color: #f8d7da;
      border: 2px solid #dc3545;
      padding: 15px;
      margin: 20px 0;
      border-radius: 6px;
      text-align: center;
    }
    .deadline-date {
      font-size: 24px;
      font-weight: bold;
      color: #dc3545;
      margin: 10px 0;
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
    ul {
      padding-left: 20px;
    }
    li {
      margin: 8px 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">SheriaBot</div>
      <div class="alert-badge">
        ${params.severity} Priority: ${getAlertTypeLabel(params.alertType)}
      </div>
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
        <div style="margin-top: 10px;">
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

      <p><strong>Need Help?</strong><br>
      Our compliance team can assist you with:</p>
      <ul>
        <li>Detailed regulatory analysis</li>
        <li>Compliance gap assessment</li>
        <li>Action plan development</li>
        <li>Policy framework updates</li>
      </ul>

      <p>Contact us at <a href="mailto:${emailConfig.branding.supportEmail}">${emailConfig.branding.supportEmail}</a> for assistance.</p>

      <p>Best regards,<br>The SheriaBot Compliance Team</p>
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