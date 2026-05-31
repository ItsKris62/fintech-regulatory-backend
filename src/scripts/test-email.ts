#!/usr/bin/env tsx

/**
 * Email Service Test Script
 * Tests Resend connection and email templates
 */

import { sendEmail, getEmailQueueStats } from '../lib/email/client';
import { generateWelcomeEmail } from '../lib/email/templates/welcome';
import { generatePasswordResetEmail } from '../lib/email/templates/password-reset';
import { generatePolicyReadyEmail } from '../lib/email/templates/policy-ready';
import { generateComplianceAlertEmail } from '../lib/email/templates/compliance-alert';
import { appConfig } from '../config/app.config';
import * as fs from 'fs';
import * as path from 'path';

interface TestResult {
  name: string;
  success: boolean;
  message: string;
}

const results: TestResult[] = [];

/**
 * Run a test and record result
 */
async function runTest(
  name: string,
  testFn: () => Promise<{ success: boolean; message: string }>
): Promise<void> {
  try {
    console.log(`\n🧪 ${name}...`);
    const result = await testFn();
    
    results.push({
      name,
      success: result.success,
      message: result.message,
    });

    if (result.success) {
      console.log(`   ✅ ${result.message}`);
    } else {
      console.log(`   ❌ ${result.message}`);
    }
  } catch (error: any) {
    results.push({
      name,
      success: false,
      message: error.message,
    });

    console.log(`   ❌ Error: ${error.message}`);
  }
}

/**
 * Test 1: Check configuration
 */
async function testConfiguration() {
  return runTest('Email Configuration', async () => {
    const hasApiKey = !!process.env.RESEND_API_KEY;
    const hasFromEmail = !!process.env.FROM_EMAIL;

    if (!hasApiKey) {
      return {
        success: false,
        message: 'RESEND_API_KEY not configured',
      };
    }

    if (!hasFromEmail) {
      return {
        success: false,
        message: 'FROM_EMAIL not configured',
      };
    }

    return {
      success: true,
      message: 'Email configuration valid',
    };
  });
}

/**
 * Test 2: Generate welcome email template
 */
async function testWelcomeTemplate() {
  return runTest('Welcome Email Template', async () => {
    const params = {
      name: 'John Omondi',
      email: 'john@example.com',
      verificationUrl: 'https://sheriabot.com/verify?token=abc123',
      role: 'STARTUP',
      organizationName: 'Fintech Innovations Ltd',
    };

    const { html, text, subject } = generateWelcomeEmail(params);

    if (!html || !text || !subject) {
      return {
        success: false,
        message: 'Template generation failed',
      };
    }

    // Save to file for preview
    const previewDir = path.join(process.cwd(), 'email-previews');
    if (!fs.existsSync(previewDir)) {
      fs.mkdirSync(previewDir);
    }

    fs.writeFileSync(
      path.join(previewDir, 'welcome.html'),
      html
    );

    return {
      success: true,
      message: `Template generated (preview: email-previews/welcome.html)`,
    };
  });
}

/**
 * Test 3: Generate password reset template
 */
async function testPasswordResetTemplate() {
  return runTest('Password Reset Email Template', async () => {
    const params = {
      name: 'Jane Wanjiru',
      email: 'jane@example.com',
      resetUrl: 'https://sheriabot.com/reset?token=xyz789',
      expiresIn: '1 hour',
      ipAddress: '41.90.22.1',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    };

    const { html, text, subject } = generatePasswordResetEmail(params);

    if (!html || !text || !subject) {
      return {
        success: false,
        message: 'Template generation failed',
      };
    }

    // Save to file for preview
    const previewDir = path.join(process.cwd(), 'email-previews');
    fs.writeFileSync(
      path.join(previewDir, 'password-reset.html'),
      html
    );

    return {
      success: true,
      message: `Template generated (preview: email-previews/password-reset.html)`,
    };
  });
}

/**
 * Test 4: Generate policy ready template
 */
async function testPolicyReadyTemplate() {
  return runTest('Policy Ready Email Template', async () => {
    const params = {
      name: 'David Otieno',
      policyTitle: 'Digital Lending Compliance Framework',
      policyId: 'policy-123',
      policyUrl: 'https://sheriabot.com/policies/policy-123',
      executiveSummary: 'Comprehensive framework for digital credit providers covering licensing, consumer protection, data privacy, and fair debt collection practices.',
      regulatoryAreas: ['Fintech & Digital Lending', 'Data Protection', 'Consumer Protection'],
      generationTime: 45000, // 45 seconds
      citationCount: 23,
    };

    const { html, text, subject } = generatePolicyReadyEmail(params);

    if (!html || !text || !subject) {
      return {
        success: false,
        message: 'Template generation failed',
      };
    }

    // Save to file for preview
    const previewDir = path.join(process.cwd(), 'email-previews');
    fs.writeFileSync(
      path.join(previewDir, 'policy-ready.html'),
      html
    );

    return {
      success: true,
      message: `Template generated (preview: email-previews/policy-ready.html)`,
    };
  });
}

/**
 * Test 5: Generate compliance alert template
 */
async function testComplianceAlertTemplate() {
  return runTest('Compliance Alert Email Template', async () => {
    const params = {
      name: 'Sarah Muthoni',
      alertTitle: 'New Data Protection Regulations Effective March 1, 2024',
      alertType: 'REGULATION_CHANGE' as const,
      severity: 'HIGH' as const,
      description: 'The Office of the Data Protection Commissioner has issued new regulations requiring enhanced consent mechanisms for processing personal data in digital lending applications.',
      affectedAreas: ['Data Protection', 'Fintech & Digital Lending'],
      actionRequired: 'Update your mobile app consent flows and privacy notices to comply with the new requirements before the March 1, 2024 deadline.',
      deadline: 'March 1, 2024',
      resourceUrl: 'https://sheriabot.com/alerts/alert-456',
      recommendations: [
        'Review current data collection and consent practices',
        'Update privacy policy and terms of service',
        'Implement enhanced consent management in your application',
        'Train customer support staff on new requirements',
        'Schedule compliance audit before deadline',
      ],
    };

    const { html, text, subject } = generateComplianceAlertEmail(params);

    if (!html || !text || !subject) {
      return {
        success: false,
        message: 'Template generation failed',
      };
    }

    // Save to file for preview
    const previewDir = path.join(process.cwd(), 'email-previews');
    fs.writeFileSync(
      path.join(previewDir, 'compliance-alert.html'),
      html
    );

    return {
      success: true,
      message: `Template generated (preview: email-previews/compliance-alert.html)`,
    };
  });
}

/**
 * Test 6: Send test email (requires valid Resend API key)
 */
async function testSendEmail() {
  return runTest('Send Test Email', async () => {
    // Get test email from command line args or use default
    const testEmail = process.argv[2] || process.env.TEST_EMAIL;

    if (!testEmail) {
      return {
        success: false,
        message: 'No test email provided (usage: tsx scripts/test-email.ts your@email.com)',
      };
    }

    if (appConfig.isProduction) {
      return {
        success: false,
        message: 'Test emails disabled in production',
      };
    }

    const result = await sendEmail({
      to: testEmail,
      subject: 'SheriaBot Test Email',
      html: '<h1>Test Email</h1><p>If you received this, your email configuration is working correctly!</p>',
      text: 'Test Email\n\nIf you received this, your email configuration is working correctly!',
    });

    if (!result.success) {
      return {
        success: false,
        message: `Failed to send: ${result.error}`,
      };
    }

    return {
      success: true,
      message: `Test email sent successfully to ${testEmail} (Message ID: ${result.messageId})`,
    };
  });
}

/**
 * Test 7: Check email queue stats
 */
async function testQueueStats() {
  return runTest('Email Queue Statistics', async () => {
    const stats = await getEmailQueueStats();

    return {
      success: true,
      message: `Pending: ${stats.pending}, Failed: ${stats.failed}, Recent: ${stats.recentSent}`,
    };
  });
}

/**
 * Print summary
 */
function printSummary() {
  console.log('\n' + '='.repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(60));

  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const total = results.length;

  console.log(`\nTotal Tests: ${total}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);

  if (failed > 0) {
    console.log('\n⚠️  Failed Tests:');
    results
      .filter((r) => !r.success)
      .forEach((r) => {
        console.log(`   - ${r.name}: ${r.message}`);
      });
  }

  console.log('\n' + '='.repeat(60));

  if (failed === 0) {
    console.log('🎉 All tests passed! Email service is ready to use.');
    console.log('\n📧 Email template previews saved to: email-previews/');
  } else {
    console.log('⚠️  Some tests failed. Please check configuration.');
  }

  console.log('\n💡 To send a test email, run:');
  console.log('   tsx scripts/test-email.ts your@email.com');
}

/**
 * Main execution
 */
async function main() {
  console.log('🧪 SheriaBot Email Service Test');
  console.log('='.repeat(60));
  console.log(`Environment: ${appConfig.env}`);
  console.log('='.repeat(60));

  try {
    await testConfiguration();
    await testWelcomeTemplate();
    await testPasswordResetTemplate();
    await testPolicyReadyTemplate();
    await testComplianceAlertTemplate();
    await testQueueStats();

    // Only send actual email if test address provided
    if (process.argv[2] || process.env.TEST_EMAIL) {
      await testSendEmail();
    }

    printSummary();

    process.exit(results.some((r) => !r.success) ? 1 : 0);
  } catch (error: any) {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  }
}

main();