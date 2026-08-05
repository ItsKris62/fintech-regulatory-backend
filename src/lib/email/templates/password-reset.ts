import { emailConfig } from '@/config/email.config';
import { LOGO_URL } from '@/emails/theme';

/**
 * Password reset email template parameters
 */
export interface PasswordResetEmailParams {
  name: string;
  email: string;
  resetUrl: string;
  expiresIn: string; // e.g., "1 hour"
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Generate password reset email HTML
 */
function generatePasswordResetHTML(params: PasswordResetEmailParams): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
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
    h1 {
      color: #0f172a;
      font-size: 22px;
      font-weight: 700;
      margin-top: 0;
      margin-bottom: 20px;
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
    .alert {
      background-color: #fffbe3;
      border-left: 4px solid #d97706;
      padding: 16px;
      margin: 20px 0;
      border-radius: 6px;
      color: #92400e;
      font-size: 14px;
    }
    .danger {
      background-color: #fef2f2;
      border-left: 4px solid #dc2626;
      padding: 16px;
      margin: 20px 0;
      border-radius: 6px;
      color: #991b1b;
      font-size: 14px;
    }
    .info-box {
      background-color: #f8fafc;
      border: 1px solid #e2e8f0;
      padding: 16px;
      margin: 20px 0;
      border-radius: 6px;
      font-size: 13px;
      color: #475569;
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
    code {
      background-color: #f1f5f9;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 14px;
      color: #0f172a;
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
      <h1>Reset Your Password 🔐</h1>

      <div class="content">
        <p>Hello ${params.name},</p>

        <p>We received a request to reset the password for your SheriaBot account (<code>${params.email}</code>).</p>

        <div class="alert">
          <strong>⏰ Time Sensitive:</strong> This password reset link will expire in <strong>${params.expiresIn}</strong>.
        </div>

        <p>Click the button below to choose a new password:</p>

        <div style="text-align: center;">
          <a href="${params.resetUrl}" class="button">
            Reset Password
          </a>
        </div>

        ${params.ipAddress || params.userAgent ? `
          <div class="info-box">
            <strong>Request Details:</strong><br>
            ${params.ipAddress ? `IP Address: ${params.ipAddress}<br>` : ''}
            ${params.userAgent ? `Device: ${params.userAgent}` : ''}
          </div>
        ` : ''}

        <div class="danger">
          <strong>⚠️ Security Warnings:</strong>
          <ul style="margin: 8px 0 0; padding-left: 20px;">
            <li>Never share this link with anyone</li>
            <li>SheriaBot will never ask for your password via email</li>
            <li>If you didn't request this reset, please ignore this email and contact support immediately</li>
            <li>Consider enabling two-factor authentication after resetting your password</li>
          </ul>
        </div>

        <p><strong>Didn't request this?</strong><br>
        If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>

        <p>For security reasons, we recommend:</p>
        <ul style="padding-left: 20px;">
          <li>Using a strong, unique password</li>
          <li>Not reusing passwords from other sites</li>
          <li>Enabling two-factor authentication</li>
          <li>Reviewing your recent account activity</li>
        </ul>

        <p>If you need assistance, contact us at <a href="mailto:${emailConfig.branding.supportEmail}">${emailConfig.branding.supportEmail}</a>.</p>

        <p>Best regards,<br><strong>The SheriaBot Security Team</strong></p>
      </div>

      <div class="footer">
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
 * Generate password reset email plain text version
 */
function generatePasswordResetText(params: PasswordResetEmailParams): string {
  return `
RESET YOUR PASSWORD

Hello ${params.name},

We received a request to reset the password for your SheriaBot account (${params.email}).

⏰ TIME SENSITIVE
This password reset link will expire in ${params.expiresIn}.

RESET YOUR PASSWORD
Visit the following link to choose a new password:
${params.resetUrl}

${params.ipAddress || params.userAgent ? `
REQUEST DETAILS
${params.ipAddress ? `IP Address: ${params.ipAddress}\n` : ''}${params.userAgent ? `Device: ${params.userAgent}` : ''}
` : ''}

⚠️ SECURITY WARNINGS
• Never share this link with anyone
• SheriaBot will never ask for your password via email
• If you didn't request this reset, please ignore this email and contact support immediately
• Consider enabling two-factor authentication after resetting your password

DIDN'T REQUEST THIS?
If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.

SECURITY RECOMMENDATIONS
• Use a strong, unique password
• Don't reuse passwords from other sites
• Enable two-factor authentication
• Review your recent account activity

NEED HELP?
Contact us at ${emailConfig.branding.supportEmail}

Best regards,
The SheriaBot Security Team

---
${emailConfig.content.footer}

Privacy Policy: ${emailConfig.content.privacyPolicyUrl}
Terms of Service: ${emailConfig.content.termsUrl}
  `.trim();
}

/**
 * Generate complete password reset email
 */
export function generatePasswordResetEmail(params: PasswordResetEmailParams): {
  html: string;
  text: string;
  subject: string;
} {
  return {
    html: generatePasswordResetHTML(params),
    text: generatePasswordResetText(params),
    subject: 'Reset Your SheriaBot Password',
  };
}