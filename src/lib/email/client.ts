import { Resend } from 'resend';
import { emailConfig, getSenderAddress } from '@/config/email.config';
import { logger } from '@/utils/logger';
import { redis } from '@/lib/redis/client';
import { EmailServiceError } from '@/utils/error';

/**
 * Email send options
 */
export interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
  }>;
  tags?: Array<{
    name: string;
    value: string;
  }>;
}

/**
 * Email send result
 */
export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Initialize Resend client
 */
const resend = new Resend(emailConfig.api.key);

/**
 * Check email rate limit
 * @param identifier Email address or user ID
 * @param timeWindow 'minute' | 'hour' | 'day'
 * @returns true if rate limit exceeded
 */
async function checkEmailRateLimit(
  identifier: string,
  timeWindow: 'minute' | 'hour' | 'day'
): Promise<boolean> {
  const limits = {
    minute: { max: emailConfig.rateLimit.maxPerMinute, window: 60 },
    hour: { max: emailConfig.rateLimit.maxPerHour, window: 3600 },
    day: { max: emailConfig.rateLimit.maxPerDay, window: 86400 },
  };

  const limit = limits[timeWindow];
  const key = `email:ratelimit:${identifier}:${timeWindow}`;

  try {
    const count = await redis.incr(key);

    // Set expiration on first increment
    if (count === 1) {
      await redis.expire(key, limit.window);
    }

    return count > limit.max;
  } catch (error) {
    logger.error({
      type: 'email_rate_limit_error',
      identifier,
      error,
    });
    // Fail open - allow email if rate limit check fails
    return false;
  }
}

/**
 * Check global rate limit (across all users)
 * @returns true if global limit exceeded
 */
async function checkGlobalRateLimit(): Promise<boolean> {
  const key = 'email:ratelimit:global:minute';
  const max = emailConfig.rateLimit.globalMaxPerMinute;

  try {
    const count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, 60);
    }

    return count > max;
  } catch (error) {
    logger.error({
      type: 'email_global_rate_limit_error',
      error,
    });
    return false;
  }
}

/**
 * Log email send attempt
 * @param to Recipient email
 * @param subject Email subject
 * @param success Whether send was successful
 * @param messageId Resend message ID
 * @param error Error message if failed
 */
async function logEmailSend(
  to: string | string[],
  subject: string,
  success: boolean,
  messageId?: string,
  error?: string
): Promise<void> {
  const recipients = Array.isArray(to) ? to.join(', ') : to;

  if (success) {
    logger.info({
      type: 'email_sent',
      to: recipients,
      subject,
      messageId,
    });
  } else {
    logger.error({
      type: 'email_send_failed',
      to: recipients,
      subject,
      error,
    });
  }

  // Store in Redis for monitoring (last 100 emails)
  try {
    const logEntry = JSON.stringify({
      to: recipients,
      subject,
      success,
      messageId,
      error,
      timestamp: new Date().toISOString(),
    });

    await redis.lpush('email:log', logEntry);
    await redis.ltrim('email:log', 0, 99); // Keep only last 100
  } catch (error) {
    // Don't throw - logging failure shouldn't prevent email
    logger.error({
      type: 'email_log_storage_error',
      error,
    });
  }
}

/**
 * Send email using Resend
 * @param options Email options
 * @returns Email result
 * 
 * @example
 * const result = await sendEmail({
 *   to: 'user@example.com',
 *   subject: 'Welcome to SheriaBot',
 *   html: '<h1>Welcome!</h1>',
 *   text: 'Welcome!',
 * });
 */
export async function sendEmail(options: EmailOptions): Promise<EmailResult> {
  const startTime = Date.now();

  try {
    // Validate recipient
    const recipients = Array.isArray(options.to) ? options.to : [options.to];
    
    if (recipients.length === 0) {
      throw new Error('No recipients specified');
    }

    // Check rate limits
    for (const recipient of recipients) {
      // Check per-user rate limits
      const minuteExceeded = await checkEmailRateLimit(recipient, 'minute');
      if (minuteExceeded) {
        throw new Error(`Rate limit exceeded for ${recipient} (minute)`);
      }

      const hourExceeded = await checkEmailRateLimit(recipient, 'hour');
      if (hourExceeded) {
        throw new Error(`Rate limit exceeded for ${recipient} (hour)`);
      }

      const dayExceeded = await checkEmailRateLimit(recipient, 'day');
      if (dayExceeded) {
        throw new Error(`Rate limit exceeded for ${recipient} (day)`);
      }
    }

    // Check global rate limit
    const globalExceeded = await checkGlobalRateLimit();
    if (globalExceeded) {
      throw new Error('Global email rate limit exceeded');
    }

    // Send email via Resend
    const response = await resend.emails.send({
      from: getSenderAddress(),
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
      replyTo: options.replyTo || emailConfig.defaults.replyTo,
      cc: options.cc,
      bcc: options.bcc,
      attachments: options.attachments,
      tags: options.tags,
    });

    const duration = Date.now() - startTime;

    // Log success
    await logEmailSend(options.to, options.subject, true, response.data?.id);

    logger.info({
      type: 'email_sent_success',
      to: options.to,
      subject: options.subject,
      messageId: response.data?.id,
      duration,
    });

    return {
      success: true,
      messageId: response.data?.id,
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;

    // Log failure
    await logEmailSend(options.to, options.subject, false, undefined, error.message);

    logger.error({
      type: 'email_send_error',
      to: options.to,
      subject: options.subject,
      error: error.message,
      duration,
    });

    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Send email and throw error if fails
 * Useful for critical emails that must be sent
 * @param options Email options
 */
export async function sendEmailOrThrow(options: EmailOptions): Promise<string> {
  const result = await sendEmail(options);

  if (!result.success) {
    throw new EmailServiceError(result.error);
  }

  return result.messageId!;
}

/**
 * Queue email for later sending
 * Useful for non-critical emails or when rate limited
 * @param options Email options
 * @param priority Higher priority emails sent first (default: 0)
 */
export async function queueEmail(
  options: EmailOptions,
  priority: number = 0
): Promise<void> {
  try {
    const queueEntry = JSON.stringify({
      options,
      priority,
      queuedAt: new Date().toISOString(),
      attempts: 0,
    });

    // Add to Redis list (higher priority = lower score)
    await redis.zadd(
      emailConfig.queue.queueName,
      -priority,
      queueEntry
    );

    logger.info({
      type: 'email_queued',
      to: options.to,
      subject: options.subject,
      priority,
    });
  } catch (error: any) {
    logger.error({
      type: 'email_queue_error',
      to: options.to,
      subject: options.subject,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Process email queue
 * Should be called periodically by a job processor
 * @param batchSize Number of emails to process (default: 10)
 */
export async function processEmailQueue(batchSize: number = 10): Promise<number> {
  try {
    // Get emails from queue (highest priority first)
    const entries = await redis.zrange(
      emailConfig.queue.queueName,
      0,
      batchSize - 1
    );

    if (entries.length === 0) {
      return 0;
    }

    let processed = 0;

    for (const entry of entries) {
      try {
        const queuedEmail = JSON.parse(entry);
        const { options, attempts } = queuedEmail;

        // Try to send
        const result = await sendEmail(options);

        if (result.success) {
          // Remove from queue
          await redis.zrem(emailConfig.queue.queueName, entry);
          processed++;
        } else {
          // Increment attempts
          const newAttempts = attempts + 1;

          if (newAttempts >= emailConfig.queue.retry.maxAttempts) {
            // Max retries reached - move to failed queue
            await redis.zrem(emailConfig.queue.queueName, entry);
            await redis.lpush('email:queue:failed', entry);
            await redis.ltrim('email:queue:failed', 0, 999); // Keep last 1000

            logger.warn({
              type: 'email_queue_max_retries',
              to: options.to,
              subject: options.subject,
              attempts: newAttempts,
            });
          } else {
            // Update attempts count
            queuedEmail.attempts = newAttempts;
            const updatedEntry = JSON.stringify(queuedEmail);

            await redis.zrem(emailConfig.queue.queueName, entry);
            await redis.zadd(
              emailConfig.queue.queueName,
              -queuedEmail.priority,
              updatedEntry
            );
          }
        }
      } catch (error: any) {
        logger.error({
          type: 'email_queue_process_error',
          error: error.message,
        });
      }
    }

    logger.info({
      type: 'email_queue_processed',
      processed,
      total: entries.length,
    });

    return processed;
  } catch (error: any) {
    logger.error({
      type: 'email_queue_process_error',
      error: error.message,
    });
    return 0;
  }
}

/**
 * Get email queue statistics
 */
export async function getEmailQueueStats(): Promise<{
  pending: number;
  failed: number;
  recentSent: number;
}> {
  try {
    const [pending, failed, recentSent] = await Promise.all([
      redis.zcard(emailConfig.queue.queueName),
      redis.llen('email:queue:failed'),
      redis.llen('email:log'),
    ]);

    return { pending, failed, recentSent };
  } catch (error) {
    return { pending: 0, failed: 0, recentSent: 0 };
  }
}

/**
 * Get recent email logs
 * @param limit Number of logs to retrieve (default: 10)
 */
export async function getRecentEmailLogs(limit: number = 10): Promise<any[]> {
  try {
    const logs = await redis.lrange('email:log', 0, limit - 1);
    return logs.map(log => JSON.parse(log));
  } catch (error) {
    return [];
  }
}

/**
 * Clear failed email queue
 * Use with caution!
 */
export async function clearFailedEmails(): Promise<void> {
  try {
    await redis.del('email:queue:failed');
    logger.info('Failed email queue cleared');
  } catch (error: any) {
    logger.error({
      type: 'email_clear_failed_error',
      error: error.message,
    });
  }
}

// Export Resend client for advanced usage
export { resend };