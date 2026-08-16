import { logger } from '@/utils/logger';

/**
 * Lightweight error tracking for production.
 * Tracks error rates and logs critical alerts when thresholds are breached.
 * No external dependency - uses structured logging for Render logs/drains.
 */

interface ErrorEntry {
  message: string;
  code: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

class ErrorTracker {
  private errors = new Map<string, ErrorEntry>();
  private windowMs: number;
  private alertThreshold: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(windowMs: number = 5 * 60 * 1000, alertThreshold: number = 10) {
    this.windowMs = windowMs;
    this.alertThreshold = alertThreshold;
  }

  /**
   * Start the periodic cleanup of stale entries.
   * Call once at application startup.
   */
  start(): void {
    this.cleanupInterval = setInterval(() => this.cleanup(), this.windowMs);
    // Allow the process to exit even if this timer is pending
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Stop the tracker (call on graceful shutdown).
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Strip internal paths and stack traces from error messages before storage.
   * Prevents Prisma invocation paths, Render file paths, and node_modules from
   * accumulating in memory and appearing in health endpoint responses.
   */
  private sanitize(raw: string): string {
    // Drop everything from the first stack frame onward
    const stackStart = raw.indexOf('\n    at ');
    const message = stackStart !== -1 ? raw.substring(0, stackStart) : raw;

    // Categorize by known internal path patterns
    if (/\/prisma\/|prisma\.|PrismaClient/i.test(message)) {
      return 'Database error';
    }
    if (/\/opt\/render\/|\/opt\/app\//.test(message)) {
      return 'Internal server error';
    }
    if (/node_modules/.test(message)) {
      return 'Internal server error';
    }
    // Strip connection strings that may contain credentials
    if (/\b(postgres(?:ql)?|redis|mongodb|mysql):\/\/[^@\s]*@/i.test(message)) {
      return 'Internal server error';
    }
    // Strip raw SQL fragments (SELECT...FROM, INSERT INTO, UPDATE...SET, DELETE FROM)
    if (/\bSELECT\b.{0,120}\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\b.{0,120}\bSET\b|\bDELETE\s+FROM\b/i.test(message)) {
      return 'Database error';
    }

    return message.slice(0, 200);
  }

  /**
   * Record an error occurrence.
   */
  track(error: Error | string, code: string = 'UNKNOWN'): void {
    const message = this.sanitize(error instanceof Error ? error.message : error);
    const key = `${code}:${message.slice(0, 120)}`;
    const now = Date.now();

    const existing = this.errors.get(key);

    if (existing) {
      existing.count++;
      existing.lastSeen = now;
    } else {
      this.errors.set(key, {
        message: message.slice(0, 200),
        code,
        count: 1,
        firstSeen: now,
        lastSeen: now,
      });
    }

    const entry = this.errors.get(key)!;

    // Alert if threshold breached within the window
    if (entry.count === this.alertThreshold) {
      logger.error(
        {
          type: 'error_rate_alert',
          code,
          message: entry.message,
          count: entry.count,
          windowMs: this.windowMs,
        },
        `Error rate alert: "${code}" hit ${entry.count} times in ${this.windowMs / 1000}s`
      );
    }
  }

  /**
   * Get a summary of recent errors (for /health/detailed or admin dashboards).
   */
  getSummary(): { totalUniqueErrors: number; topErrors: ErrorEntry[] } {
    const entries = Array.from(this.errors.values());
    const sorted = entries.sort((a, b) => b.count - a.count).slice(0, 10);

    return {
      totalUniqueErrors: entries.length,
      topErrors: sorted,
    };
  }

  /**
   * Remove entries older than the window.
   */
  private cleanup(): void {
    const cutoff = Date.now() - this.windowMs;

    for (const [key, entry] of this.errors) {
      if (entry.lastSeen < cutoff) {
        this.errors.delete(key);
      }
    }
  }
}

/** Singleton error tracker  -  5 min window, alert at 10 occurrences */
export const errorTracker = new ErrorTracker(5 * 60 * 1000, 10);
export { ErrorTracker };
