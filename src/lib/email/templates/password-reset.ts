import { emailConfig } from '@/config/email.config';

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
    h1 {
      color: #1a1a1a;
      font-size: 24px;
      margin-bottom: 20px;
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
    .alert {
      background-color: #fff3cd;
      border-left: 4px solid #ffc107;
      padding: 15px;
      margin: 20px 0;
      border-radius: 4px;
      color: #856404;
    }
    .danger {
      background-color: #f8d7da;
      border-left: 4px solid #dc3545;
      padding: 15px;
      margin: 20px 0;
      border-radius: 4px;
      color: #721c24;
    }
    .info-box {
      background-color: #f8f9fa;
      border: 1px solid #dee2e6;
      padding: 15px;
      margin: 20px 0;
      border-radius: 4px;
      font-size: 14px;
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
    code {
      background-color: #f4f4f4;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">SheriaBot</div>
    </div>

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
        <ul style="margin: 10px 0; padding-left: 20px;">
          <li>Never share this link with anyone</li>
          <li>SheriaBot will never ask for your password via email</li>
          <li>If you didn't request this reset, please ignore this email and contact support immediately</li>
          <li>Consider enabling two-factor authentication after resetting your password</li>
        </ul>
      </div>

      <p><strong>Didn't request this?</strong><br>
      If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>

      <p>For security reasons, we recommend:</p>
      <ul>
        <li>Using a strong, unique password</li>
        <li>Not reusing passwords from other sites</li>
        <li>Enabling two-factor authentication</li>
        <li>Reviewing your recent account activity</li>
      </ul>

      <p>If you need assistance, contact us at <a href="mailto:${emailConfig.branding.supportEmail}">${emailConfig.branding.supportEmail}</a>.</p>

      <p>Best regards,<br>The SheriaBot Security Team</p>
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