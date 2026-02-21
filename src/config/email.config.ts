import { appConfig } from './app.config';

/**
 * Email configuration for Resend
 * Handles email sending, templates, and rate limiting
 */
export const emailConfig = {
  /**
   * Resend API configuration
   */
  api: {
    key: appConfig.email.apiKey,
    baseUrl: 'https://api.resend.com',
  },

  /**
   * Email sender configuration
   */
  from: {
    email: appConfig.email.from,
    name: appConfig.email.fromName,
  },

  /**
   * Email templates directory
   * All email templates stored here
   */
  templates: {
    dir: 'src/lib/email/templates',

    // Template file names
    welcome: 'welcome',
    passwordReset: 'password-reset',
    emailVerification: 'email-verification',
    policyReady: 'policy-ready',
    complianceAlert: 'compliance-alert',
    organizationInvite: 'organization-invite',
  },

  /**
   * Rate limiting for email sending
   * Prevents abuse and stays within Resend limits
   */
  rateLimit: {
    // Maximum emails per minute (per user)
    maxPerMinute: 5,

    // Maximum emails per hour (per user)
    maxPerHour: 20,

    // Maximum emails per day (per user)
    maxPerDay: 100,

    // Global rate limit (across all users)
    globalMaxPerMinute: 100,
    globalMaxPerHour: 1000,
  },

  /**
   * Email queue configuration
   * Use Redis for queuing failed/delayed emails
   */
  queue: {
    // Enable email queuing
    enabled: true,

    // Queue name in Redis
    queueName: 'email-queue',

    // Retry configuration
    retry: {
      maxAttempts: 3,
      backoff: {
        type: 'exponential' as const,
        delay: 5000, // 5 seconds initial delay
      },
    },

    // Failed email retention (days)
    failedRetention: 7,
  },

  /**
   * Email categories for tracking and filtering
   */
  categories: {
    TRANSACTIONAL: 'transactional', // Login, password reset, etc.
    NOTIFICATION: 'notification', // Policy ready, alerts
    MARKETING: 'marketing', // Product updates, newsletters
    SYSTEM: 'system', // System alerts, maintenance
  },

  /**
   * Email options and defaults
   */
  defaults: {
    // Reply-to email
    replyTo: appConfig.email.from,

    // Enable email tracking
    tracking: appConfig.isProduction,

    // Email format
    format: 'html' as const,

    // Include plain text version
    includePlainText: true,

    // Timeout for sending (ms)
    timeout: 10000,
  },

  /**
   * Branding configuration for emails
   */
  branding: {
    logo: `${appConfig.appUrl}/assets/logo.png`,
    primaryColor: '#10B981', // Tailwind Green 500 (regulatory/compliance theme)
    companyName: 'SheriaBot',
    companyAddress: 'Nairobi, Kenya',
    supportEmail: 'support@sheriabot.co.ke',
    websiteUrl: appConfig.frontendUrl,
  },

  /**
   * Email content configuration
   */
  content: {
    // Footer text for all emails
    footer: '© 2024 SheriaBot. AI-Powered Regulatory Compliance for Kenya.',

    // Unsubscribe link template
    unsubscribeText: 'If you no longer wish to receive these emails, you can unsubscribe here.',

    // Privacy policy link
    privacyPolicyUrl: `${appConfig.frontendUrl}/privacy`,

    // Terms of service link
    termsUrl: `${appConfig.frontendUrl}/terms`,
  },

  /**
   * Logging configuration
   */
  logging: {
    // Log all sent emails in development
    logSent: appConfig.isDevelopment,

    // Log failed emails always
    logFailed: true,

    // Log email metadata (to, subject) but not content
    logMetadataOnly: appConfig.isProduction,
  },
} as const;

/**
 * Get full sender address in "Name <email>" format
 */
export function getSenderAddress(): string {
  return `${emailConfig.from.name} <${emailConfig.from.email}>`;
}

/**
 * Check if email rate limit exceeded
 * @param sentCount Number of emails sent in the time window
 * @param timeWindow 'minute' | 'hour' | 'day'
 * @returns true if limit exceeded
 */
export function isRateLimitExceeded(
  sentCount: number,
  timeWindow: 'minute' | 'hour' | 'day'
): boolean {
  const limits = {
    minute: emailConfig.rateLimit.maxPerMinute,
    hour: emailConfig.rateLimit.maxPerHour,
    day: emailConfig.rateLimit.maxPerDay,
  };

  return sentCount >= limits[timeWindow];
}

/**
 * Get email template path
 * @param templateName Name of the template
 * @returns Full path to template file
 */
export function getTemplatePath(templateName: string): string {
  return `${emailConfig.templates.dir}/${templateName}.ts`;
}

/**
 * Export type
 */
export type EmailConfig = typeof emailConfig;