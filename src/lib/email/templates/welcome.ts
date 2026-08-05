import { emailConfig } from '@/config/email.config';
import { LOGO_URL, EMAIL_SIGNATURE_LOGO_URL } from '@/emails/theme';

/**
 * Welcome email template parameters
 */
export interface WelcomeEmailParams {
  name: string;
  email: string;
  verificationUrl: string;
  role: string;
  organizationName?: string;
}

/**
 * Generate welcome email HTML
 */
function generateWelcomeHTML(params: WelcomeEmailParams): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to SheriaBot</title>
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
      text-align: center;
    }
    .info-box {
      background-color: #f0fdf4;
      border-left: 4px solid #15803d;
      padding: 16px;
      margin: 20px 0;
      border-radius: 6px;
      color: #166534;
      font-size: 14px;
    }
    .warning {
      background-color: #fffbe3;
      border-left: 4px solid #d97706;
      padding: 16px;
      margin: 20px 0;
      border-radius: 6px;
      font-size: 14px;
      color: #92400e;
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
      <h1>Welcome to SheriaBot, ${params.name}! 🎉</h1>

      <div class="content">
        <p>Thank you for creating your SheriaBot account. We're excited to help you navigate Kenya's regulatory landscape with AI-powered compliance solutions.</p>

        ${params.organizationName ? `
          <div class="info-box">
            <strong>Your Organization:</strong> ${params.organizationName}<br>
            <strong>Your Role:</strong> ${params.role}
          </div>
        ` : `
          <div class="info-box">
            <strong>Your Role:</strong> ${params.role}
          </div>
        `}

        <p>To get started, please verify your email address by clicking the button below:</p>

        <div style="text-align: center;">
          <a href="${params.verificationUrl}" class="button">
            Verify Email Address
          </a>
        </div>

        <div class="warning">
          <strong>⚠️ Security Notice:</strong> This verification link will expire in 24 hours. If you didn't create a SheriaBot account, please ignore this email.
        </div>

        <p><strong>What's Next?</strong></p>
        <ul style="padding-left: 20px;">
          <li>Verify your email to activate your account</li>
          <li>Complete your profile setup</li>
          ${params.role === 'REGULATOR' 
            ? '<li>Start generating policy frameworks based on Kenyan regulations</li>' 
            : '<li>Submit compliance queries and get instant guidance</li>'}
          <li>Explore our legal corpus of Kenyan laws and regulations</li>
        </ul>

        <p>If you have any questions, our support team is here to help at <a href="mailto:${emailConfig.branding.supportEmail}">${emailConfig.branding.supportEmail}</a>.</p>

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
        <p>${emailConfig.branding.companyAddress}</p>
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Generate welcome email plain text version
 */
function generateWelcomeText(params: WelcomeEmailParams): string {
  return `
Welcome to SheriaBot, ${params.name}!

Thank you for creating your SheriaBot account. We're excited to help you navigate Kenya's regulatory landscape with AI-powered compliance solutions.

${params.organizationName ? `Your Organization: ${params.organizationName}\n` : ''}Your Role: ${params.role}

VERIFY YOUR EMAIL
To get started, please verify your email address by visiting:
${params.verificationUrl}

⚠️ SECURITY NOTICE
This verification link will expire in 24 hours. If you didn't create a SheriaBot account, please ignore this email.

WHAT'S NEXT?
• Verify your email to activate your account
• Complete your profile setup
${params.role === 'REGULATOR' 
  ? '• Start generating policy frameworks based on Kenyan regulations' 
  : '• Submit compliance queries and get instant guidance'}
• Explore our legal corpus of Kenyan laws and regulations

NEED HELP?
Contact our support team: ${emailConfig.branding.supportEmail}

Best regards,
The SheriaBot Team

---
${emailConfig.content.footer}

Privacy Policy: ${emailConfig.content.privacyPolicyUrl}
Terms of Service: ${emailConfig.content.termsUrl}

${emailConfig.branding.companyAddress}
  `.trim();
}

/**
 * Generate complete welcome email
 */
export function generateWelcomeEmail(params: WelcomeEmailParams): {
  html: string;
  text: string;
  subject: string;
} {
  return {
    html: generateWelcomeHTML(params),
    text: generateWelcomeText(params),
    subject: 'Welcome to SheriaBot - Verify Your Email',
  };
}