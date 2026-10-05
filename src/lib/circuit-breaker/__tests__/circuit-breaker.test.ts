import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  circuitBreakerRegistry,
  executeWithBreaker,
  getCircuitBreakerMetrics,
  formatCircuitBreakerPrometheusMetrics,
  CircuitBreakerOpenError,
  SUPPORTED_PROVIDERS,
} from '../circuit-breaker.service';

describe('Circuit Breaker Service', () => {
  beforeEach(() => {
    circuitBreakerRegistry.resetAll();
  });

  it('initializes all 8 required external providers', () => {
    const expected = ['stripe', 'intasend', 'resend', 'pinecone', 'anthropic', 'openai', 'gemini', 'cohere'];
    expect(SUPPORTED_PROVIDERS).toEqual(expect.arrayContaining(expected));
    expect(SUPPORTED_PROVIDERS.length).toBe(8);

    const metrics = getCircuitBreakerMetrics();
    expect(metrics.length).toBe(8);
    metrics.forEach((m) => {
      expect(m.state).toBe(0); // CLOSED
      expect(m.tripCount).toBe(0);
      expect(m.rejectionCount).toBe(0);
    });
  });

  it('executes outbound call successfully when healthy', async () => {
    const fn = vi.fn().mockResolvedValue('success-payload');
    const result = await executeWithBreaker('stripe', fn);

    expect(result).toBe('success-payload');
    expect(fn).toHaveBeenCalledTimes(1);

    const metric = getCircuitBreakerMetrics().find((m) => m.provider === 'stripe');
    expect(metric?.state).toBe(0); // CLOSED
    expect(metric?.tripCount).toBe(0);
    expect(metric?.rejectionCount).toBe(0);
  });

  it('trips breaker to OPEN when failure rate reaches 50%', async () => {
    // Cause failures to trip breaker
    for (let i = 0; i < 5; i++) {
      try {
        await executeWithBreaker('anthropic', async () => {
          throw new Error('API Overloaded 529');
        });
      } catch {
        // expected
      }
    }

    const metric = getCircuitBreakerMetrics().find((m) => m.provider === 'anthropic');
    expect(metric?.tripCount).toBeGreaterThanOrEqual(1);
    expect(metric?.state).toBe(2); // OPEN
  });

  it('short-circuits calls when OPEN and increments rejection_count', async () => {
    const breaker = circuitBreakerRegistry.get('resend');
    breaker.trip(); // Force OPEN

    const fn = vi.fn().mockResolvedValue('should not run');

    await expect(executeWithBreaker('resend', fn)).rejects.toThrow(CircuitBreakerOpenError);
    expect(fn).not.toHaveBeenCalled();

    const metric = getCircuitBreakerMetrics().find((m) => m.provider === 'resend');
    expect(metric?.rejectionCount).toBe(1);
  });

  it('formats Prometheus metrics for /metrics endpoint correctly', () => {
    const breaker = circuitBreakerRegistry.get('pinecone');
    breaker.trip();

    const metricsStr = formatCircuitBreakerPrometheusMetrics();
    expect(metricsStr).toContain('# HELP sheriabot_circuit_breaker_state');
    expect(metricsStr).toContain('# TYPE sheriabot_circuit_breaker_state gauge');
    expect(metricsStr).toContain('sheriabot_circuit_breaker_state{provider="pinecone"} 2');
    expect(metricsStr).toContain('sheriabot_circuit_breaker_trips_total{provider="pinecone"} 1');
    expect(metricsStr).toContain('sheriabot_circuit_breaker_rejections_total{provider="pinecone"} 0');
  });

  it('bypasses circuit breaker when CIRCUIT_BREAKERS_ENABLED=false', async () => {
    const originalEnv = process.env.CIRCUIT_BREAKERS_ENABLED;
    process.env.CIRCUIT_BREAKERS_ENABLED = 'false';

    try {
      const breaker = circuitBreakerRegistry.get('intasend');
      breaker.trip(); // Even if breaker is OPEN

      const fn = vi.fn().mockResolvedValue('bypassed-ok');
      const result = await executeWithBreaker('intasend', fn);

      expect(result).toBe('bypassed-ok');
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      process.env.CIRCUIT_BREAKERS_ENABLED = originalEnv;
    }
  });
});
