/**
 * Circuit Breaker Service for Outbound Integrations
 *
 * Wraps external providers with cockatiel Circuit Breaker policies:
 * - 50% failure rate over 30s sliding window trips the breaker to OPEN.
 * - Cooldown of 60s before transitioning to HALF_OPEN to test recovery.
 * - Exposes state, trip_count, and rejection_count for Prometheus scraping on /metrics.
 * - Global bypass available via CIRCUIT_BREAKERS_ENABLED=false.
 */

import {
  circuitBreaker,
  handleAll,
  SamplingBreaker,
  BrokenCircuitError,
  CircuitState,
} from 'cockatiel';
import { logger } from '@/utils/logger';

export const SUPPORTED_PROVIDERS = [
  'stripe',
  'intasend',
  'resend',
  'pinecone',
  'anthropic',
  'openai',
  'gemini',
] as const;

export type CircuitBreakerProvider = (typeof SUPPORTED_PROVIDERS)[number];

export class CircuitBreakerOpenError extends Error {
  readonly provider: CircuitBreakerProvider;
  readonly code = 'CIRCUIT_BREAKER_OPEN';
  readonly status = 503;

  constructor(provider: CircuitBreakerProvider) {
    super(`Circuit breaker for outbound provider '${provider}' is currently OPEN. Request short-circuited.`);
    this.name = 'CircuitBreakerOpenError';
    this.provider = provider;
  }
}

export interface CircuitBreakerMetrics {
  provider: CircuitBreakerProvider;
  state: number; // 0=CLOSED, 1=HALF_OPEN, 2=OPEN
  tripCount: number;
  rejectionCount: number;
}

export interface CircuitBreakerInstance {
  provider: CircuitBreakerProvider;
  execute<T>(fn: () => Promise<T>): Promise<T>;
  trip(): void;
  reset(): void;
  getMetrics(): CircuitBreakerMetrics;
}

class ProviderCircuitBreaker implements CircuitBreakerInstance {
  readonly provider: CircuitBreakerProvider;
  private breakerPolicy: ReturnType<typeof circuitBreaker>;
  private tripCount = 0;
  private rejectionCount = 0;
  private forceOpen = false;

  constructor(provider: CircuitBreakerProvider) {
    this.provider = provider;
    this.breakerPolicy = this.createPolicy();
  }

  private createPolicy(): ReturnType<typeof circuitBreaker> {
    const policy = circuitBreaker(handleAll, {
      halfOpenAfter: 60000,
      breaker: new SamplingBreaker({
        threshold: 0.5,
        duration: 30000,
        minimumRps: 5 / 30, // Requires at least 5 calls within the 30s window before evaluating threshold
      }),
    });

    policy.onBreak(() => {
      this.tripCount++;
      logger.warn({
        type: 'circuit_breaker_tripped',
        provider: this.provider,
        tripCount: this.tripCount,
        halfOpenAfterMs: 60000,
      });
    });

    policy.onReset(() => {
      logger.info({
        type: 'circuit_breaker_reset',
        provider: this.provider,
      });
    });

    policy.onHalfOpen(() => {
      logger.info({
        type: 'circuit_breaker_half_open',
        provider: this.provider,
      });
    });

    return policy;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.forceOpen) {
      this.rejectionCount++;
      throw new CircuitBreakerOpenError(this.provider);
    }

    try {
      return await this.breakerPolicy.execute(fn);
    } catch (error: any) {
      if (error instanceof BrokenCircuitError || error?.name === 'BrokenCircuitError') {
        this.rejectionCount++;
        logger.warn({
          type: 'circuit_breaker_short_circuit',
          provider: this.provider,
          rejectionCount: this.rejectionCount,
        });
        throw new CircuitBreakerOpenError(this.provider);
      }
      throw error;
    }
  }

  trip(): void {
    this.forceOpen = true;
    this.tripCount++;
  }

  reset(): void {
    this.forceOpen = false;
    this.tripCount = 0;
    this.rejectionCount = 0;
    this.breakerPolicy = this.createPolicy();
  }

  getMetrics(): CircuitBreakerMetrics {
    let stateCode = 0;
    if (this.forceOpen) {
      stateCode = 2; // OPEN
    } else {
      switch (this.breakerPolicy.state) {
        case CircuitState.Open:
        case CircuitState.Isolated:
          stateCode = 2;
          break;
        case CircuitState.HalfOpen:
          stateCode = 1;
          break;
        case CircuitState.Closed:
        default:
          stateCode = 0;
          break;
      }
    }

    return {
      provider: this.provider,
      state: stateCode,
      tripCount: this.tripCount,
      rejectionCount: this.rejectionCount,
    };
  }
}

class CircuitBreakerRegistry {
  private instances = new Map<CircuitBreakerProvider, ProviderCircuitBreaker>();

  constructor() {
    for (const provider of SUPPORTED_PROVIDERS) {
      this.instances.set(provider, new ProviderCircuitBreaker(provider));
    }
  }

  get(provider: CircuitBreakerProvider): ProviderCircuitBreaker {
    const instance = this.instances.get(provider);
    if (!instance) {
      throw new Error(`Unsupported circuit breaker provider: ${provider}`);
    }
    return instance;
  }

  resetAll(): void {
    for (const instance of this.instances.values()) {
      instance.reset();
    }
  }

  getAllMetrics(): CircuitBreakerMetrics[] {
    return Array.from(this.instances.values()).map((inst) => inst.getMetrics());
  }
}

export const circuitBreakerRegistry = new CircuitBreakerRegistry();

/**
 * Execute an outbound call protected by the corresponding provider's circuit breaker.
 */
export async function executeWithBreaker<T>(
  provider: CircuitBreakerProvider,
  fn: () => Promise<T>,
): Promise<T> {
  if (process.env.CIRCUIT_BREAKERS_ENABLED === 'false') {
    return fn();
  }

  const breaker = circuitBreakerRegistry.get(provider);
  return breaker.execute(fn);
}

/**
 * Retrieve snapshot of all provider circuit breaker metrics.
 */
export function getCircuitBreakerMetrics(): CircuitBreakerMetrics[] {
  return circuitBreakerRegistry.getAllMetrics();
}

/**
 * Formats circuit breaker telemetry as standard Prometheus exposition format.
 */
export function formatCircuitBreakerPrometheusMetrics(): string {
  const metrics = getCircuitBreakerMetrics();
  const lines: string[] = [
    '# HELP sheriabot_circuit_breaker_state Current state of the circuit breaker (0=CLOSED, 1=HALF_OPEN, 2=OPEN).',
    '# TYPE sheriabot_circuit_breaker_state gauge',
  ];

  for (const m of metrics) {
    lines.push(`sheriabot_circuit_breaker_state{provider="${m.provider}"} ${m.state}`);
  }

  lines.push('');
  lines.push('# HELP sheriabot_circuit_breaker_trips_total Cumulative count of circuit breaker trip events (transitions to OPEN).');
  lines.push('# TYPE sheriabot_circuit_breaker_trips_total counter');

  for (const m of metrics) {
    lines.push(`sheriabot_circuit_breaker_trips_total{provider="${m.provider}"} ${m.tripCount}`);
  }

  lines.push('');
  lines.push('# HELP sheriabot_circuit_breaker_rejections_total Requests short-circuited while breaker was OPEN.');
  lines.push('# TYPE sheriabot_circuit_breaker_rejections_total counter');

  for (const m of metrics) {
    lines.push(`sheriabot_circuit_breaker_rejections_total{provider="${m.provider}"} ${m.rejectionCount}`);
  }

  return lines.join('\n');
}
