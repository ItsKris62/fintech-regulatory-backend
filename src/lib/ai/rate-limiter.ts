import { aiConfig } from '@/config/ai.config';
import { logger } from '@/utils/logger';

/**
 * In-process rate limiter for Anthropic API calls.
 *
 * Enforces two independent constraints:
 *   1. Requests per minute   -  sliding window over the last 60 s
 *   2. Max concurrent        -  active in-flight requests at any instant
 *
 * acquire() blocks until a slot is available, then returns.
 * release() must be called in a finally block after every acquire().
 */
export class AIRateLimiter {
  private activeRequests = 0;
  private requestTimestamps: number[] = [];
  private readonly queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  private readonly maxPerMinute: number;
  private readonly maxConcurrent: number;

  constructor(maxPerMinute: number, maxConcurrent: number) {
    this.maxPerMinute = maxPerMinute;
    this.maxConcurrent = maxConcurrent;
  }

  async acquire(): Promise<void> {
    // Purge timestamps older than 60 s
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(ts => now - ts < 60_000);

    // If per-minute window is full, wait until the oldest slot expires
    if (this.requestTimestamps.length >= this.maxPerMinute) {
      const oldestTs = this.requestTimestamps[0];
      const waitMs = 60_000 - (now - oldestTs) + 50; // +50 ms buffer

      logger.warn({
        type: 'ai_rate_limit_wait',
        waitMs,
        activeRequests: this.activeRequests,
        queueLength: this.queue.length,
        windowCount: this.requestTimestamps.length,
      });

      await this.sleep(waitMs);
      return this.acquire(); // Re-evaluate after waiting
    }

    // If concurrency cap is reached, queue this request
    if (this.activeRequests >= this.maxConcurrent) {
      logger.warn({
        type: 'ai_concurrency_limit_wait',
        activeRequests: this.activeRequests,
        maxConcurrent: this.maxConcurrent,
        queueLength: this.queue.length,
      });

      return new Promise<void>((resolve, reject) => {
        this.queue.push({ resolve, reject });
      });
    }

    // Slot available  -  claim it
    this.activeRequests++;
    this.requestTimestamps.push(Date.now());
  }

  release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);

    // Drain the queue if there is capacity
    if (this.queue.length > 0 && this.activeRequests < this.maxConcurrent) {
      const next = this.queue.shift();
      if (next) {
        this.activeRequests++;
        this.requestTimestamps.push(Date.now());
        next.resolve();
      }
    }
  }

  /** Reject all queued waiters (e.g., on server shutdown). */
  drainQueue(reason = 'Rate limiter shut down'): void {
    const err = new Error(reason);
    for (const waiter of this.queue.splice(0)) {
      waiter.reject(err);
    }
  }

  stats(): { activeRequests: number; queueLength: number; windowCount: number } {
    const now = Date.now();
    const windowCount = this.requestTimestamps.filter(ts => now - ts < 60_000).length;
    return { activeRequests: this.activeRequests, queueLength: this.queue.length, windowCount };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const aiRateLimiter = new AIRateLimiter(
  aiConfig.rateLimit.requestsPerMinute,
  aiConfig.rateLimit.maxConcurrent
);
