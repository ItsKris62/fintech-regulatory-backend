# Email Service (Resend)

This directory contains the email service for SheriaBot using Resend for transactional and notification emails.

## 📁 Structure

```
email/
├── client.ts                    # Resend client with rate limiting and queuing
├── mailer.service.ts           # High-level email service with template integration
├── templates/
│   ├── welcome.ts              # Welcome email with verification link
│   ├── password-reset.ts       # Password reset email
│   ├── policy-ready.ts         # Policy generation complete notification
│   └── compliance-alert.ts     # Compliance alerts and regulatory updates
└── README.md                   # This file
```

## 🚀 Getting Started

### 1. Environment Setup

Obtain a Resend API key from [resend.com](https://resend.com) and add to `.env`:

```bash
RESEND_API_KEY=re_...
FROM_EMAIL=noreply@yourdomain.com
```

### 2. Test Email Service

```bash
# Test configuration and generate template previews
tsx scripts/test-email.ts

# Send actual test email
tsx scripts/test-email.ts your@email.com
```

## 📚 Usage Examples

### Send Welcome Email

```typescript
import { mailer } from '@/lib/email/mailer.service';

await mailer.sendWelcomeEmail({
  name: 'John Omondi',
  email: 'john@example.com',
  verificationUrl: 'https://sheriabot.co.ke/verify?token=abc123',
  role: 'STARTUP',
  organizationName: 'Fintech Innovations Ltd',
});
```

### Send Password Reset Email

```typescript
import { mailer } from '@/lib/email/mailer.service';

await mailer.sendPasswordResetEmail({
  name: 'Jane Wanjiru',
  email: 'jane@example.com',
  resetUrl: 'https://sheriabot.co.ke/reset?token=xyz789',
  expiresIn: '1 hour',
  ipAddress: '41.90.22.1', // optional
  userAgent: 'Mozilla/5.0...', // optional
});
```

### Send Policy Ready Notification

```typescript
import { mailer } from '@/lib/email/mailer.service';

await mailer.sendPolicyReadyEmail({
  name: 'David Otieno',
  policyTitle: 'Digital Lending Compliance Framework',
  policyId: 'policy-123',
  policyUrl: 'https://sheriabot.co.ke/policies/policy-123',
  executiveSummary: 'Comprehensive framework for...',
  regulatoryAreas: ['Fintech & Digital Lending', 'Data Protection'],
  generationTime: 45000, // milliseconds
  citationCount: 23,
}, false); // false = queue instead of immediate send
```

### Send Compliance Alert

```typescript
import { mailer } from '@/lib/email/mailer.service';

await mailer.sendComplianceAlertEmail({
  name: 'Sarah Muthoni',
  alertTitle: 'New Data Protection Regulations',
  alertType: 'REGULATION_CHANGE',
  severity: 'HIGH',
  description: 'The ODPC has issued new regulations...',
  affectedAreas: ['Data Protection', 'Fintech & Digital Lending'],
  actionRequired: 'Update your consent flows...',
  deadline: 'March 1, 2024',
  resourceUrl: 'https://sheriabot.co.ke/alerts/alert-456',
  recommendations: [
    'Review current practices',
    'Update privacy policy',
    'Implement enhanced consent',
  ],
});
```

### Send Generic Notification

```typescript
import { mailer } from '@/lib/email/mailer.service';

await mailer.sendNotificationEmail(
  'user@example.com',
  'Your report is ready',
  'Your monthly compliance report is now available for download.',
  '<p>Your monthly compliance report is now available for download.</p>' // optional HTML
);
```

### Low-Level Email Sending

```typescript
import { sendEmail } from '@/lib/email/client';

const result = await sendEmail({
  to: 'user@example.com',
  subject: 'Custom Email',
  html: '<h1>Hello</h1><p>Custom email content</p>',
  text: 'Hello\n\nCustom email content',
  replyTo: 'support@sheriabot.co.ke', // optional
  cc: ['manager@company.com'], // optional
  bcc: ['archive@company.com'], // optional
  attachments: [ // optional
    {
      filename: 'document.pdf',
      content: pdfBuffer,
    },
  ],
  tags: [ // optional (for tracking in Resend)
    { name: 'category', value: 'reports' },
  ],
});

if (result.success) {
  console.log('Email sent:', result.messageId);
} else {
  console.error('Email failed:', result.error);
}
```

## 🔄 Email Queue

### Queue Email for Later Sending

```typescript
import { queueEmail } from '@/lib/email/client';

// Queue with priority (higher = higher priority)
await queueEmail({
  to: 'user@example.com',
  subject: 'Queued Email',
  html: '<p>This will be sent later</p>',
  text: 'This will be sent later',
}, 10); // priority: 10
```

### Process Email Queue

```typescript
import { processEmailQueue } from '@/lib/email/client';

// Process up to 10 queued emails
const processed = await processEmailQueue(10);
console.log(`Processed ${processed} emails`);
```

Set up a cron job or scheduled task to process the queue regularly:

```typescript
// In your job scheduler
setInterval(async () => {
  await processEmailQueue(20);
}, 60000); // Every minute
```

### Check Queue Statistics

```typescript
import { getEmailQueueStats } from '@/lib/email/client';

const stats = await getEmailQueueStats();
console.log({
  pending: stats.pending,
  failed: stats.failed,
  recentSent: stats.recentSent,
});
```

### View Recent Email Logs

```typescript
import { getRecentEmailLogs } from '@/lib/email/client';

const logs = await getRecentEmailLogs(20);
logs.forEach(log => {
  console.log(`${log.to}: ${log.subject} - ${log.success ? 'Sent' : 'Failed'}`);
});
```

## 📝 Creating Custom Templates

### 1. Create Template File

Create `src/lib/email/templates/custom-template.ts`:

```typescript
import { emailConfig } from '@/config/email.config';

export interface CustomTemplateParams {
  name: string;
  customData: string;
}

function generateCustomHTML(params: CustomTemplateParams): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; }
    .container { max-width: 600px; margin: 0 auto; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Hello ${params.name}!</h1>
    <p>${params.customData}</p>
  </div>
</body>
</html>
  `;
}

function generateCustomText(params: CustomTemplateParams): string {
  return `Hello ${params.name}!\n\n${params.customData}`;
}

export function generateCustomTemplate(params: CustomTemplateParams) {
  return {
    html: generateCustomHTML(params),
    text: generateCustomText(params),
    subject: 'Custom Email Subject',
  };
}
```

### 2. Add to Mailer Service

Update `mailer.service.ts`:

```typescript
import { generateCustomTemplate, CustomTemplateParams } from './templates/custom-template';

// Add method to MailerService class
async sendCustomEmail(params: CustomTemplateParams): Promise<void> {
  const { html, text, subject } = generateCustomTemplate(params);
  
  const userEmail = await this.getUserEmail(params.name);
  
  await sendEmail({
    to: userEmail,
    subject,
    html,
    text,
  });
}
```

## 🔒 Rate Limiting

Email sending is automatically rate limited to prevent abuse:

- **Per user/email:**
  - 5 emails per minute
  - 20 emails per hour
  - 100 emails per day

- **Global (all users):**
  - 100 emails per minute
  - 1000 emails per hour

If rate limit is exceeded, the email is automatically queued for later sending.

## 🎨 Template Styling Guidelines

### Colors

- Primary: `#10B981` (Green - represents regulatory/compliance)
- Secondary: `#6B7280`
- Success: `#10B981`
- Warning: `#F59E0B`
- Danger: `#EF4444`

### Best Practices

1. **Inline CSS**: All styles must be inline for email client compatibility
2. **Max Width**: 600px for optimal mobile rendering
3. **Font Stack**: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
4. **Responsive**: Use media queries sparingly; design mobile-first
5. **Plain Text**: Always include plain text version
6. **CTA Buttons**: Make them obvious and accessible
7. **Branding**: Consistent SheriaBot branding across all templates

### Testing Templates

Preview templates before sending:

```bash
tsx scripts/test-email.ts
```

This generates HTML previews in `email-previews/` directory that you can open in a browser.

## 🐛 Troubleshooting

### Emails Not Sending

1. **Check Resend API key** is valid
2. **Verify FROM_EMAIL** domain is verified in Resend
3. **Check rate limits** - may be queued
4. **View logs** with `getRecentEmailLogs()`
5. **Check queue** with `getEmailQueueStats()`

### Emails Going to Spam

1. **Verify domain** in Resend dashboard
2. **Add SPF/DKIM** records to your DNS
3. **Use verified from address**
4. **Avoid spam trigger words**
5. **Include unsubscribe link** (for marketing emails)

### Failed Emails in Queue

```typescript
import { clearFailedEmails } from '@/lib/email/client';

// Clear failed email queue (use with caution)
await clearFailedEmails();
```

## 📊 Monitoring

### Track Email Metrics

Resend provides built-in analytics:
- Delivery rate
- Open rate (if tracking enabled)
- Click rate
- Bounce rate

Access via Resend dashboard or API.

### Custom Tracking

Use tags to categorize emails:

```typescript
await sendEmail({
  to: 'user@example.com',
  subject: 'Test',
  html: '<p>Test</p>',
  tags: [
    { name: 'category', value: 'transactional' },
    { name: 'template', value: 'welcome' },
    { name: 'version', value: 'v2' },
  ],
});
```

## 🚀 Production Checklist

- [ ] Resend API key configured
- [ ] Domain verified in Resend
- [ ] SPF and DKIM records added to DNS
- [ ] FROM_EMAIL uses verified domain
- [ ] Email queue processor running (cron/scheduled task)
- [ ] Rate limits configured appropriately
- [ ] All templates tested and previewed
- [ ] Unsubscribe links added (if sending marketing emails)
- [ ] Email logging enabled
- [ ] Monitoring and alerts set up

## 📚 Additional Resources

- [Resend Documentation](https://resend.com/docs)
- [Email Best Practices](https://resend.com/docs/knowledge-base/best-practices)
- [HTML Email Guide](https://www.campaignmonitor.com/css/)
- [Email on Acid](https://www.emailonacid.com/) - Email testing service