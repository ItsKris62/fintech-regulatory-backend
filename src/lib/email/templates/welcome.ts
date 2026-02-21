import { emailConfig } from '@/config/email.config';

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
    .tagline {
      color: #666;
      font-size: 14px;
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
      text-align: center;
    }
    .button:hover {
      background-color: #0f9d76;
    }
    .info-box {
      background-color: #f8f9fa;
      border-left: 4px solid ${emailConfig.branding.primaryColor};
      padding: 15px;
      margin: 20px 0;
      border-radius: 4px;
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
    .warning {
      background-color: #fff3cd;
      border-left: 4px solid #ffc107;
      padding: 12px;
      margin: 20px 0;
      font-size: 14px;
      color: #856404;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">SheriaBot</div>
      <div class="tagline">AI-Powered Regulatory Compliance for Kenya</div>
    </div>

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
      <ul>
        <li>Verify your email to activate your account</li>
        <li>Complete your profile setup</li>
        ${params.role === 'REGULATOR' 
          ? '<li>Start generating policy frameworks based on Kenyan regulations</li>' 
          : '<li>Submit compliance queries and get instant guidance</li>'}
        <li>Explore our legal corpus of Kenyan laws and regulations</li>
      </ul>

      <p>If you have any questions, our support team is here to help at <a href="mailto:${emailConfig.branding.supportEmail}">${emailConfig.branding.supportEmail}</a>.</p>

      <p>Best regards,<br>The SheriaBot Team</p>
    </div>

    <div class="footer">
      <p>${emailConfig.content.footer}</p>
      <p>
        <a href="${emailConfig.content.privacyPolicyUrl}">Privacy Policy</a> | 
        <a href="${emailConfig.content.termsUrl}">Terms of Service</a>
      </p>
      <p>${emailConfig.branding.companyAddress}</p>
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